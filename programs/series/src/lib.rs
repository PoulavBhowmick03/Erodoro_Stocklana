// SPDX-License-Identifier: Apache-2.0
//! Option series: the fully-collateralized vault and settlement engine.
//!
//! One series locks a tokenized equity and issues two complementary claim
//! tokens, `P` and `N`.
//! Holders `split` collateral into `P + N`, `merge` equal `P + N` back before
//! maturity, and after maturity `settle` the series against an oracle and
//! `redeem` each side pro-rata from a frozen pool.
//!
//! The P holder has written a covered call: capped upside, full downside. The
//! N holder owns the call and can expire worthless. **This is not downside
//! protection** — below the strike the P holder still takes the whole fall,
//! and the premium from selling N is the only cushion.
//!
//! Core guarantee: the vault never pays out more than
//! it holds. Every payout rounds down, pools are computed once at settlement
//! and stored, and no admin function can touch active collateral.
//!
//! # What is different on Solana
//!
//! - The collateral is Token-2022 with five active extensions, four of which
//!   are levers the issuer holds over the vault. Two of them need code:
//!   `scaledUiAmount` (§6, the effective strike) and `transferHook` (§9,
//!   dormant today, armed without warning). See `collateral.rs`.
//! - A permanent delegate can drain a *settled* vault, so redemption prices
//!   the shortfall instead of paying first-come-first-served (§7).
//! - All decision logic lives in `logic.rs` as pure functions, so the
//!   invariants can be tested without a validator.

#![allow(unexpected_cfgs)]
// Anchor 0.31's generated entrypoint calls deprecated `AccountInfo::realloc`.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{
    self as claim_token, Burn, Mint as ClaimMint, MintTo, Token, TokenAccount as ClaimAccount,
};
use anchor_spl::token_interface::{
    Mint as CollateralMint, TokenAccount as CollateralAccount, TokenInterface,
};
use common::{OptionsError, SeriesStatus};
use oracle_adapter::{read_quote_at_or_after, FeedConfig};

pub mod collateral;
pub mod logic;
pub mod state;

use collateral::{read_multipliers, require_no_scheduled_change, transfer_collateral};
use logic::{
    assess_settlement_health, fee_amount, redeem_payout, require_mergeable, require_settleable,
    require_settlement_window, require_splittable, validate_series_params,
    validate_settlement_timing, SettleParams,
};
use state::{SeriesConfig, Settlement};

declare_id!("AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9");

pub const SERIES_SEED: &[u8] = b"series";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const P_MINT_SEED: &[u8] = b"p-mint";
pub const N_MINT_SEED: &[u8] = b"n-mint";

/// Parameters for a new series.
///
/// Grouped into one struct so the PDA seeds can reference `params.strike` and
/// `params.maturity_ts` without pinning the order of a long argument list.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CreateSeriesParams {
    pub strike: i128,
    pub maturity_ts: i64,
    pub price_decimals: u32,
    pub settlement_delay_secs: i64,
    pub max_oracle_age_secs: i64,
    pub max_price_lag_secs: i64,
    pub min_split_amount: u64,
    pub fee_bps: u16,
}

#[program]
pub mod series {
    use super::*;

    /// Open a series over a collateral mint, an oracle feed, a strike and a
    /// maturity.
    ///
    /// Permissionless by design. What makes a series *canonical* is the
    /// factory's registry, not the ability to create one. Creating a
    /// series confers no power over it: `factory_authority` is recorded for
    /// cross-referencing and `admin` gets only the pause and dust paths.
    pub fn create_series(ctx: Context<CreateSeries>, params: CreateSeriesParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let collateral_mint = &ctx.accounts.collateral_mint;

        // §6: capture the multiplier the series is being priced against, and
        // refuse to open one that would settle through a corporate action we
        // already know is coming.
        let multipliers = read_multipliers(&collateral_mint.to_account_info())?;
        require_no_scheduled_change(&multipliers, now, params.maturity_ts)?;
        let multiplier_at_creation = multipliers.fixed_at(now)?;

        validate_series_params(
            params.strike,
            params.price_decimals,
            params.maturity_ts,
            now,
            params.settlement_delay_secs,
            params.max_oracle_age_secs,
            params.max_price_lag_secs,
            params.min_split_amount,
            params.fee_bps,
            multiplier_at_creation,
        )?;

        // `read_quote_at_or_after` enforces both the series' age bound and the
        // feed config's own bound. Validate against the tighter one now; a
        // series whose settlement delay outlives every admissible quote can
        // never recover after creation because all three values are immutable.
        validate_settlement_timing(
            params.settlement_delay_secs,
            params.max_oracle_age_secs,
            params.max_price_lag_secs,
            ctx.accounts.oracle_adapter.max_age_secs,
        )?;
        require!(
            ctx.accounts.oracle_adapter.min_verification_signatures > 0,
            OptionsError::InvalidOracle
        );

        // The feed must be the one this series will settle against, and the
        // claim tokens must be distinguishable.
        require_keys_neq!(
            ctx.accounts.p_mint.key(),
            ctx.accounts.n_mint.key(),
            OptionsError::InvalidParams
        );

        let series = &mut ctx.accounts.series;
        series.factory = ctx.accounts.factory_authority.key();
        series.admin = ctx.accounts.admin.key();
        series.collateral_mint = collateral_mint.key();
        series.collateral_vault = ctx.accounts.collateral_vault.key();
        series.oracle_adapter = ctx.accounts.oracle_adapter.key();
        series.p_mint = ctx.accounts.p_mint.key();
        series.n_mint = ctx.accounts.n_mint.key();
        series.strike = params.strike;
        series.price_decimals = params.price_decimals;
        series.collateral_decimals = collateral_mint.decimals;
        series.multiplier_at_creation = multiplier_at_creation;
        series.maturity_ts = params.maturity_ts;
        series.settlement_delay_secs = params.settlement_delay_secs;
        series.max_oracle_age_secs = params.max_oracle_age_secs;
        series.max_price_lag_secs = params.max_price_lag_secs;
        series.min_split_amount = params.min_split_amount;
        series.fee_bps = params.fee_bps;
        series.fee_recipient = ctx.accounts.fee_recipient.key();
        series.status = SeriesStatus::Open;
        series.bump = ctx.bumps.series;

        emit!(SeriesCreated {
            series: series.key(),
            collateral_mint: series.collateral_mint,
            p_mint: series.p_mint,
            n_mint: series.n_mint,
            strike: series.strike,
            price_decimals: series.price_decimals,
            maturity_ts: series.maturity_ts,
            multiplier_at_creation,
        });
        Ok(())
    }

    /// Lock `amount` collateral and mint equal `P` and `N` to the holder.
    pub fn split<'info>(ctx: Context<'_, '_, '_, 'info, Split<'info>>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let series = &ctx.accounts.series;
        require_splittable(series.status, now, series.maturity_ts)?;

        // Re-check the multiplier schedule on every mint, not just at creation.
        //
        // The creation-time check is a snapshot: the issuer can schedule a
        // change *after* a series opens, and a series that was safe on Monday
        // is not on Tuesday. Without this, someone splitting into a series that
        // has since become unsafe gets no warning at all.
        //
        // Deliberately on the entrance only. `merge`, `redeem` and `settle`
        // never take this check -- refusing an exit would trap positions in
        // exactly the situation where holders most want out, which is a worse
        // failure than the one being guarded against.
        require_no_scheduled_change(
            &read_multipliers(&ctx.accounts.collateral_mint.to_account_info())?,
            now,
            series.maturity_ts,
        )?;

        require!(amount > 0, OptionsError::InvalidAmount);
        require!(
            amount >= series.min_split_amount,
            OptionsError::AmountTooSmall
        );

        // Pull the full deposit into the vault, then take any fee out of it,
        // so the vault is the single place collateral is accounted for.
        transfer_collateral(
            &ctx.accounts.collateral_token_program.to_account_info(),
            &ctx.accounts.holder_collateral.to_account_info(),
            &ctx.accounts.collateral_mint.to_account_info(),
            &ctx.accounts.collateral_vault.to_account_info(),
            &ctx.accounts.holder.to_account_info(),
            ctx.remaining_accounts,
            amount,
            series.collateral_decimals,
            &[],
        )?;

        let fee = fee_amount(amount, series.fee_bps)?;
        let net = amount.checked_sub(fee).ok_or(OptionsError::MathUnderflow)?;
        require!(net > 0, OptionsError::InvalidAmount);

        if fee > 0 {
            let fee_vault = ctx
                .accounts
                .fee_vault
                .as_ref()
                .ok_or(OptionsError::InvalidParams)?;
            require_keys_eq!(
                fee_vault.owner,
                series.fee_recipient,
                OptionsError::Unauthorized
            );
            let seeds = SeriesSeeds::new(series);
            let slices = seeds.slices();
            transfer_collateral(
                &ctx.accounts.collateral_token_program.to_account_info(),
                &ctx.accounts.collateral_vault.to_account_info(),
                &ctx.accounts.collateral_mint.to_account_info(),
                &fee_vault.to_account_info(),
                &ctx.accounts.series.to_account_info(),
                ctx.remaining_accounts,
                fee,
                series.collateral_decimals,
                &[&slices[..]],
            )?;
        }

        // Mint only the net, so `collateral >= p_supply` holds against the
        // balance actually retained.
        let seeds = SeriesSeeds::new(series);
        let slices = seeds.slices();
        let signer: &[&[&[u8]]] = &[&slices[..]];
        claim_token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.p_mint.to_account_info(),
                    to: ctx.accounts.receiver_p.to_account_info(),
                    authority: ctx.accounts.series.to_account_info(),
                },
                signer,
            ),
            net,
        )?;
        claim_token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.n_mint.to_account_info(),
                    to: ctx.accounts.receiver_n.to_account_info(),
                    authority: ctx.accounts.series.to_account_info(),
                },
                signer,
            ),
            net,
        )?;

        emit!(SplitExecuted {
            series: ctx.accounts.series.key(),
            holder: ctx.accounts.holder.key(),
            deposited: amount,
            minted: net,
            fee,
        });
        Ok(())
    }

    /// Burn equal `P` and `N` and return `amount` collateral.
    ///
    /// Permitted while `Open` *or* `Paused`, never after settlement — a pause
    /// stops new risk without trapping the collateral behind existing claims.
    pub fn merge<'info>(ctx: Context<'_, '_, '_, 'info, Merge<'info>>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let series = &ctx.accounts.series;
        require_mergeable(series.status, now, series.maturity_ts)?;
        require!(amount > 0, OptionsError::InvalidAmount);

        // Burn both legs before releasing anything.
        claim_token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.p_mint.to_account_info(),
                    from: ctx.accounts.holder_p.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            amount,
        )?;
        claim_token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.n_mint.to_account_info(),
                    from: ctx.accounts.holder_n.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            amount,
        )?;

        let seeds = SeriesSeeds::new(series);
        let slices = seeds.slices();
        transfer_collateral(
            &ctx.accounts.collateral_token_program.to_account_info(),
            &ctx.accounts.collateral_vault.to_account_info(),
            &ctx.accounts.collateral_mint.to_account_info(),
            &ctx.accounts.holder_collateral.to_account_info(),
            &ctx.accounts.series.to_account_info(),
            ctx.remaining_accounts,
            amount,
            series.collateral_decimals,
            &[&slices[..]],
        )?;

        emit!(MergeExecuted {
            series: ctx.accounts.series.key(),
            holder: ctx.accounts.holder.key(),
            amount,
        });
        Ok(())
    }

    /// Freeze the series against the oracle price.
    ///
    /// Permissionless and callable once. Anyone can poke it; nobody can choose
    /// the price — the quote must carry the series' own feed id, be fresh, and
    /// land inside the settlement window placed at a real market close (§8).
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let series_key = ctx.accounts.series.key();

        // Copy the config out before anything else. Settlement writes the
        // series status at the end, and every field read here is a scalar, so
        // taking them once up front keeps the shared borrow from colliding
        // with that write.
        let cfg = {
            let series = &ctx.accounts.series;
            SettleConfig {
                status: series.status,
                strike: series.strike,
                price_decimals: series.price_decimals,
                multiplier_at_creation: series.multiplier_at_creation,
                maturity_ts: series.maturity_ts,
                settlement_delay_secs: series.settlement_delay_secs,
                max_oracle_age_secs: series.max_oracle_age_secs,
                max_price_lag_secs: series.max_price_lag_secs,
            }
        };

        require_settleable(cfg.status, now, cfg.maturity_ts, cfg.settlement_delay_secs)?;

        let p_supply = ctx.accounts.p_mint.supply;
        let n_supply = ctx.accounts.n_mint.supply;
        let vault_balance = ctx.accounts.collateral_vault.amount;
        // Recorded, not gated. Reverting here would let anyone brick a series
        // permanently by burning one unit of P outside the protocol; see
        // `logic::assess_settlement_health`.
        let health = assess_settlement_health(vault_balance, p_supply, n_supply);

        let quote = read_quote_at_or_after(
            &ctx.accounts.oracle_adapter,
            &ctx.accounts.price_source.to_account_info(),
            now,
            cfg.maturity_ts,
            cfg.max_oracle_age_secs,
        )?;
        require_settlement_window(quote.timestamp, cfg.maturity_ts, cfg.max_price_lag_secs)?;

        // §6: resolve the multiplier as of the *price* timestamp, not as of
        // now. A corporate action landing between the print and this
        // transaction has not happened yet from that price's point of view.
        let multipliers = read_multipliers(&ctx.accounts.collateral_mint.to_account_info())?;
        let multiplier_at_settlement = multipliers.fixed_at(quote.timestamp)?;

        let pools = logic::compute_settlement(&SettleParams {
            strike: cfg.strike,
            price_decimals: cfg.price_decimals,
            multiplier_at_creation: cfg.multiplier_at_creation,
            multiplier_at_settlement,
            collateral: vault_balance,
            quote_price: quote.price,
            quote_decimals: quote.decimals,
        })?;

        let settlement = &mut ctx.accounts.settlement;
        settlement.series = series_key;
        settlement.price = pools.price;
        settlement.price_decimals = cfg.price_decimals;
        settlement.price_ts = quote.timestamp;
        settlement.settled_ts = now;
        settlement.collateral_at_settlement = vault_balance;
        settlement.p_supply_at_settlement = p_supply;
        settlement.n_supply_at_settlement = n_supply;
        settlement.p_pool = pools.p_pool;
        settlement.n_pool = pools.n_pool;
        settlement.p_redeemed = 0;
        settlement.n_redeemed = 0;
        settlement.p_paid = 0;
        settlement.n_paid = 0;
        settlement.multiplier_at_settlement = multiplier_at_settlement;
        settlement.effective_strike = pools.effective_strike;
        settlement.shortfall_observed = health.under_collateralized;
        settlement.supply_mismatch = health.supply_mismatch;
        settlement.bump = ctx.bumps.settlement;

        ctx.accounts.series.status = SeriesStatus::Settled;

        emit!(SeriesSettled {
            series: series_key,
            price: pools.price,
            price_decimals: cfg.price_decimals,
            price_ts: quote.timestamp,
            collateral: vault_balance,
            p_pool: pools.p_pool,
            n_pool: pools.n_pool,
            effective_strike: pools.effective_strike,
            multiplier_at_creation: cfg.multiplier_at_creation,
            multiplier_at_settlement,
            supply_mismatch: health.supply_mismatch,
            under_collateralized: health.under_collateralized,
        });
        Ok(())
    }

    /// Burn `amount` P and pay the pro-rata P payout.
    pub fn redeem_p<'info>(
        ctx: Context<'_, '_, '_, 'info, RedeemP<'info>>,
        amount: u64,
    ) -> Result<()> {
        let series = &ctx.accounts.series;
        require!(
            series.status == SeriesStatus::Settled,
            OptionsError::NotSettled
        );

        let settlement = &ctx.accounts.settlement;
        let payout = redeem_payout(
            amount,
            settlement.p_pool,
            settlement.p_supply_at_settlement,
            settlement.outstanding(),
            ctx.accounts.collateral_vault.amount,
        )?;

        claim_token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.p_mint.to_account_info(),
                    from: ctx.accounts.holder_p.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            amount,
        )?;

        let settlement = &mut ctx.accounts.settlement;
        settlement.p_redeemed = settlement
            .p_redeemed
            .checked_add(payout.quoted)
            .ok_or(OptionsError::MathOverflow)?;
        settlement.p_paid = settlement
            .p_paid
            .checked_add(payout.paid)
            .ok_or(OptionsError::MathOverflow)?;
        require!(
            settlement.p_redeemed <= settlement.p_pool,
            OptionsError::InsufficientCollateral
        );
        if payout.shortfall {
            settlement.shortfall_observed = true;
        }

        let seeds = SeriesSeeds::new(&ctx.accounts.series);
        let slices = seeds.slices();
        transfer_collateral(
            &ctx.accounts.collateral_token_program.to_account_info(),
            &ctx.accounts.collateral_vault.to_account_info(),
            &ctx.accounts.collateral_mint.to_account_info(),
            &ctx.accounts.holder_collateral.to_account_info(),
            &ctx.accounts.series.to_account_info(),
            ctx.remaining_accounts,
            payout.paid,
            ctx.accounts.series.collateral_decimals,
            &[&slices[..]],
        )?;

        emit_redemption(
            ctx.accounts.series.key(),
            ctx.accounts.holder.key(),
            Side::P,
            amount,
            &payout,
        );
        Ok(())
    }

    /// Burn `amount` N and pay the pro-rata N payout.
    pub fn redeem_n<'info>(
        ctx: Context<'_, '_, '_, 'info, RedeemN<'info>>,
        amount: u64,
    ) -> Result<()> {
        let series = &ctx.accounts.series;
        require!(
            series.status == SeriesStatus::Settled,
            OptionsError::NotSettled
        );

        let settlement = &ctx.accounts.settlement;
        let payout = redeem_payout(
            amount,
            settlement.n_pool,
            settlement.n_supply_at_settlement,
            settlement.outstanding(),
            ctx.accounts.collateral_vault.amount,
        )?;

        claim_token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.n_mint.to_account_info(),
                    from: ctx.accounts.holder_n.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            amount,
        )?;

        let settlement = &mut ctx.accounts.settlement;
        settlement.n_redeemed = settlement
            .n_redeemed
            .checked_add(payout.quoted)
            .ok_or(OptionsError::MathOverflow)?;
        settlement.n_paid = settlement
            .n_paid
            .checked_add(payout.paid)
            .ok_or(OptionsError::MathOverflow)?;
        require!(
            settlement.n_redeemed <= settlement.n_pool,
            OptionsError::InsufficientCollateral
        );
        if payout.shortfall {
            settlement.shortfall_observed = true;
        }

        let seeds = SeriesSeeds::new(&ctx.accounts.series);
        let slices = seeds.slices();
        transfer_collateral(
            &ctx.accounts.collateral_token_program.to_account_info(),
            &ctx.accounts.collateral_vault.to_account_info(),
            &ctx.accounts.collateral_mint.to_account_info(),
            &ctx.accounts.holder_collateral.to_account_info(),
            &ctx.accounts.series.to_account_info(),
            ctx.remaining_accounts,
            payout.paid,
            ctx.accounts.series.collateral_decimals,
            &[&slices[..]],
        )?;

        emit_redemption(
            ctx.accounts.series.key(),
            ctx.accounts.holder.key(),
            Side::N,
            amount,
            &payout,
        );
        Ok(())
    }

    // --- Admin ------------------------------------------------------------
    //
    // The admin's whole surface. It can stop new risk being created and clean
    // up dust once every claim has been redeemed. It cannot touch active
    // collateral, cannot settle, and cannot change any term of the series.
    // Whether this role should exist at all is §14's first open question.

    pub fn pause_splits(ctx: Context<AdminOnly>) -> Result<()> {
        let series = &mut ctx.accounts.series;
        require!(
            series.status == SeriesStatus::Open,
            OptionsError::SeriesClosed
        );
        series.status = SeriesStatus::Paused;
        emit!(SplitsPaused {
            series: series.key(),
            paused: true
        });
        Ok(())
    }

    pub fn unpause_splits(ctx: Context<AdminOnly>) -> Result<()> {
        let series = &mut ctx.accounts.series;
        require!(
            series.status == SeriesStatus::Paused,
            OptionsError::SeriesClosed
        );
        series.status = SeriesStatus::Open;
        emit!(SplitsPaused {
            series: series.key(),
            paused: false
        });
        Ok(())
    }

    /// Permanently give up the admin role for this series.
    ///
    /// §14 asks whether the admin should survive at all. The argument for
    /// keeping it: the issuer already holds four kill switches, so a contract
    /// admin adds little marginal trust. The argument against: it is one more
    /// key to lose. Both are right, and which dominates depends on the series
    /// — a long-dated series over a mint whose issuer has just armed a hook
    /// wants a pause; a short-dated one wants nothing that can be
    /// compromised.
    ///
    /// So the decision is made per series, at runtime, and it is one-way.
    /// After this, `admin` is the zero address: no signer can match it, and
    /// `pause_splits`, `unpause_splits` and `sweep_dust` are dead for the life
    /// of the series. The cost is that residual dust can never be swept — it
    /// stays in the vault, which is the right direction for a trade of
    /// convenience against trust.
    pub fn renounce_admin(ctx: Context<AdminOnly>) -> Result<()> {
        let series = &mut ctx.accounts.series;
        series.admin = Pubkey::default();
        emit!(AdminRenounced {
            series: series.key()
        });
        Ok(())
    }

    /// Sweep rounding dust to the fee recipient, only once every claim token
    /// has been redeemed.
    pub fn sweep_dust<'info>(ctx: Context<'_, '_, '_, 'info, SweepDust<'info>>) -> Result<()> {
        let series = &ctx.accounts.series;
        require!(
            series.status == SeriesStatus::Settled,
            OptionsError::NotSettled
        );
        require!(
            ctx.accounts.p_mint.supply == 0 && ctx.accounts.n_mint.supply == 0,
            OptionsError::DustSweepTooEarly
        );
        require_keys_eq!(
            ctx.accounts.fee_vault.owner,
            series.fee_recipient,
            OptionsError::Unauthorized
        );

        let remaining = ctx.accounts.collateral_vault.amount;
        let seeds = SeriesSeeds::new(series);
        let slices = seeds.slices();
        transfer_collateral(
            &ctx.accounts.collateral_token_program.to_account_info(),
            &ctx.accounts.collateral_vault.to_account_info(),
            &ctx.accounts.collateral_mint.to_account_info(),
            &ctx.accounts.fee_vault.to_account_info(),
            &ctx.accounts.series.to_account_info(),
            ctx.remaining_accounts,
            remaining,
            series.collateral_decimals,
            &[&slices[..]],
        )?;

        emit!(DustSwept {
            series: ctx.accounts.series.key(),
            amount: remaining
        });
        Ok(())
    }
}

// --- helpers --------------------------------------------------------------

/// The series config fields `settle` reads, lifted out of the account.
///
/// Settlement both reads the config and writes the status, so it takes a
/// snapshot rather than holding a borrow across the write.
struct SettleConfig {
    status: SeriesStatus,
    strike: i128,
    price_decimals: u32,
    multiplier_at_creation: i128,
    maturity_ts: i64,
    settlement_delay_secs: i64,
    max_oracle_age_secs: i64,
    max_price_lag_secs: i64,
}

/// Owned copies of the series PDA's seeds.
///
/// The seeds are derived from fields that live behind an `Account` borrow, and
/// two of them are byte arrays that have to outlive the borrow to be handed to
/// a CPI. Materializing them into one struct lets a caller hold them across
/// the mutable access that follows, which is what `settle` and both `redeem`
/// paths need.
struct SeriesSeeds {
    creator: Pubkey,
    collateral_mint: Pubkey,
    strike: [u8; 16],
    maturity_ts: [u8; 8],
    bump: [u8; 1],
}

impl SeriesSeeds {
    fn new(series: &SeriesConfig) -> Self {
        Self {
            creator: series.factory,
            collateral_mint: series.collateral_mint,
            strike: series.strike.to_le_bytes(),
            maturity_ts: series.maturity_ts.to_le_bytes(),
            bump: [series.bump],
        }
    }

    fn slices(&self) -> [&[u8]; 6] {
        [
            SERIES_SEED,
            self.creator.as_ref(),
            self.collateral_mint.as_ref(),
            &self.strike,
            &self.maturity_ts,
            &self.bump,
        ]
    }
}

enum Side {
    P,
    N,
}

fn emit_redemption(
    series: Pubkey,
    holder: Pubkey,
    side: Side,
    burned: u64,
    payout: &logic::Payout,
) {
    emit!(Redeemed {
        series,
        holder,
        is_p_side: matches!(side, Side::P),
        burned,
        quoted: payout.quoted,
        paid: payout.paid,
    });
    if payout.shortfall {
        // Make the drain visible on-chain rather than something a holder has
        // to infer from a payout that came up short.
        emit!(ShortfallObserved {
            series,
            quoted: payout.quoted,
            paid: payout.paid,
        });
    }
}

// --- Accounts -------------------------------------------------------------

#[derive(Accounts)]
#[instruction(params: CreateSeriesParams)]
pub struct CreateSeries<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The factory PDA when created through the factory, or whoever created it
    /// otherwise. Recorded, never trusted — but it *is* a PDA seed.
    ///
    /// Without it, `(collateral_mint, strike, maturity)` would name exactly one
    /// address protocol-wide, and creation is permissionless: anyone could
    /// front-run the factory, occupy the address the factory was about to use,
    /// and make the canonical series for those parameters impossible to create
    /// ever again. Seeding on the creator gives every creator their own address
    /// space, so squatting the factory's is not possible.
    pub factory_authority: Signer<'info>,

    /// CHECK: recorded as the series admin; holds only the pause and dust
    /// paths, and never signs here.
    pub admin: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + SeriesConfig::INIT_SPACE,
        seeds = [
            SERIES_SEED,
            factory_authority.key().as_ref(),
            collateral_mint.key().as_ref(),
            &params.strike.to_le_bytes(),
            &params.maturity_ts.to_le_bytes(),
        ],
        bump,
    )]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(mint::token_program = collateral_token_program)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = collateral_mint,
        associated_token::authority = series,
        associated_token::token_program = collateral_token_program,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    /// The feed this series will settle against, owned by the oracle adapter.
    pub oracle_adapter: Box<Account<'info, FeedConfig>>,

    /// P and N are plain SPL Token mints, not Token-2022: only the collateral
    /// carries extensions, and keeping the claim tokens simple means they
    /// trade anywhere with no extension handling.
    #[account(
        init,
        payer = payer,
        seeds = [P_MINT_SEED, series.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = series,
        mint::token_program = token_program,
    )]
    pub p_mint: Box<Account<'info, ClaimMint>>,

    #[account(
        init,
        payer = payer,
        seeds = [N_MINT_SEED, series.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = series,
        mint::token_program = token_program,
    )]
    pub n_mint: Box<Account<'info, ClaimMint>>,

    /// CHECK: recorded as the fee and dust recipient; never signs.
    pub fee_recipient: UncheckedAccount<'info>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Split<'info> {
    pub holder: Signer<'info>,

    #[account(
        has_one = collateral_mint,
        has_one = collateral_vault,
        has_one = p_mint,
        has_one = n_mint,
    )]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(mut)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = holder,
        token::token_program = collateral_token_program,
    )]
    pub holder_collateral: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(mut)]
    pub p_mint: Box<Account<'info, ClaimMint>>,

    #[account(mut)]
    pub n_mint: Box<Account<'info, ClaimMint>>,

    #[account(mut, token::mint = p_mint)]
    pub receiver_p: Box<Account<'info, ClaimAccount>>,

    #[account(mut, token::mint = n_mint)]
    pub receiver_n: Box<Account<'info, ClaimAccount>>,

    /// Required only when `fee_bps > 0`, which is never in V1.
    #[account(mut, token::mint = collateral_mint, token::token_program = collateral_token_program)]
    pub fee_vault: Option<Box<InterfaceAccount<'info, CollateralAccount>>>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Merge<'info> {
    pub holder: Signer<'info>,

    #[account(
        has_one = collateral_mint,
        has_one = collateral_vault,
        has_one = p_mint,
        has_one = n_mint,
    )]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(mut)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::token_program = collateral_token_program,
    )]
    pub holder_collateral: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(mut)]
    pub p_mint: Box<Account<'info, ClaimMint>>,

    #[account(mut)]
    pub n_mint: Box<Account<'info, ClaimMint>>,

    #[account(mut, token::mint = p_mint, token::authority = holder)]
    pub holder_p: Box<Account<'info, ClaimAccount>>,

    #[account(mut, token::mint = n_mint, token::authority = holder)]
    pub holder_n: Box<Account<'info, ClaimAccount>>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Settlement is permissionless; whoever pokes it pays for the account.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = collateral_mint,
        has_one = collateral_vault,
        has_one = p_mint,
        has_one = n_mint,
        has_one = oracle_adapter,
    )]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, series.key().as_ref()],
        bump,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    pub p_mint: Box<Account<'info, ClaimMint>>,

    pub n_mint: Box<Account<'info, ClaimMint>>,

    pub oracle_adapter: Box<Account<'info, FeedConfig>>,

    /// CHECK: checked against `oracle_adapter.source`, required to be owned by
    /// the Pyth receiver, and decoded as `PriceUpdateV2` by
    /// `read_quote_at_or_after`.
    pub price_source: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemP<'info> {
    pub holder: Signer<'info>,

    #[account(has_one = collateral_mint, has_one = collateral_vault, has_one = p_mint)]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(
        mut,
        has_one = series,
        seeds = [SETTLEMENT_SEED, series.key().as_ref()],
        bump = settlement.bump,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(mut)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::token_program = collateral_token_program,
    )]
    pub holder_collateral: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(mut)]
    pub p_mint: Box<Account<'info, ClaimMint>>,

    #[account(mut, token::mint = p_mint, token::authority = holder)]
    pub holder_p: Box<Account<'info, ClaimAccount>>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RedeemN<'info> {
    pub holder: Signer<'info>,

    #[account(has_one = collateral_mint, has_one = collateral_vault, has_one = n_mint)]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(
        mut,
        has_one = series,
        seeds = [SETTLEMENT_SEED, series.key().as_ref()],
        bump = settlement.bump,
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(mut)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::token_program = collateral_token_program,
    )]
    pub holder_collateral: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(mut)]
    pub n_mint: Box<Account<'info, ClaimMint>>,

    #[account(mut, token::mint = n_mint, token::authority = holder)]
    pub holder_n: Box<Account<'info, ClaimAccount>>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin)]
    pub series: Box<Account<'info, SeriesConfig>>,
}

#[derive(Accounts)]
pub struct SweepDust<'info> {
    pub admin: Signer<'info>,

    #[account(
        has_one = admin,
        has_one = collateral_mint,
        has_one = collateral_vault,
        has_one = p_mint,
        has_one = n_mint,
    )]
    pub series: Box<Account<'info, SeriesConfig>>,

    #[account(mut)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    #[account(mut)]
    pub collateral_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    #[account(mut, token::mint = collateral_mint, token::token_program = collateral_token_program)]
    pub fee_vault: Box<InterfaceAccount<'info, CollateralAccount>>,

    pub p_mint: Box<Account<'info, ClaimMint>>,

    pub n_mint: Box<Account<'info, ClaimMint>>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
}

// --- Events ---------------------------------------------------------------

#[event]
pub struct SeriesCreated {
    pub series: Pubkey,
    pub collateral_mint: Pubkey,
    pub p_mint: Pubkey,
    pub n_mint: Pubkey,
    pub strike: i128,
    pub price_decimals: u32,
    pub maturity_ts: i64,
    pub multiplier_at_creation: i128,
}

#[event]
pub struct SplitExecuted {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub deposited: u64,
    pub minted: u64,
    pub fee: u64,
}

#[event]
pub struct MergeExecuted {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SeriesSettled {
    pub series: Pubkey,
    pub price: i128,
    pub price_decimals: u32,
    pub price_ts: i64,
    pub collateral: u64,
    pub p_pool: u64,
    pub n_pool: u64,
    pub effective_strike: i128,
    pub multiplier_at_creation: i128,
    pub multiplier_at_settlement: i128,
    /// Someone burned P or N outside the protocol before settlement.
    pub supply_mismatch: bool,
    /// The vault held less than the senior claim when the series froze.
    pub under_collateralized: bool,
}

#[event]
pub struct Redeemed {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub is_p_side: bool,
    pub burned: u64,
    pub quoted: u64,
    pub paid: u64,
}

/// Emitted whenever the vault holds less than it owes — the on-chain signal
/// that the issuer's permanent delegate has moved collateral out of a settled
/// series (§7).
#[event]
pub struct ShortfallObserved {
    pub series: Pubkey,
    pub quoted: u64,
    pub paid: u64,
}

#[event]
pub struct SplitsPaused {
    pub series: Pubkey,
    pub paused: bool,
}

/// The admin role was given up for good. Nothing can pause this series or
/// sweep its dust afterwards.
#[event]
pub struct AdminRenounced {
    pub series: Pubkey,
}

#[event]
pub struct DustSwept {
    pub series: Pubkey,
    pub amount: u64,
}
