// SPDX-License-Identifier: Apache-2.0
//! Option factory.
//!
//! Creates and tracks the *canonical* series. For each one it drives
//! `series::create_series` through a CPI with the factory PDA as the
//! recorded creator, and writes a registry record.
//!
//! The factory holds no collateral and has no power over a series once it
//! exists — not even the ability to pause one. What it controls is which
//! parameters, oracles and collateral mints are allowed to become canonical in
//! the first place.
//!
//! # Creating a series is permissionless; being listed is not
//!
//! A series is a PDA of the `series` program, and anyone can create one. That
//! is deliberate — the factory's job is not to be the only door, it is to say
//! which series are canonical. A series the factory did not create has no
//! registry record, so nothing that reads the registry will surface it. Front
//! ends must list from [`SeriesRecord`], never from the `series` program's
//! accounts at large.
//!
//! # Enumeration
//!
//! There is no index account. `getProgramAccounts` filtered by discriminator
//! enumerates every [`SeriesRecord`] directly; the sequential `index` is kept
//! inside the record so listings have a stable order.

#![allow(unexpected_cfgs)]
// Anchor 0.31's generated entrypoint calls deprecated `AccountInfo::realloc`.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint as CollateralMint, TokenInterface};
use common::OptionsError;
use oracle_adapter::FeedConfig;
use series::program::Series as SeriesProgram;
use series::CreateSeriesParams;

declare_id!("CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ");

pub const FACTORY_SEED: &[u8] = b"factory";
pub const ORACLE_SEED: &[u8] = b"approved-oracle";
pub const COLLATERAL_SEED: &[u8] = b"approved-collateral";
pub const RECORD_SEED: &[u8] = b"record";

// Parameter bounds enforced at creation. These are policy, not arithmetic —
// the `series` program independently rejects anything incoherent, and these
// narrow the coherent set to the sensible one.
pub const MAX_PRICE_DECIMALS: u32 = 14;
pub const MIN_TERM_SECS: i64 = 3_600;
pub const MAX_SETTLEMENT_DELAY: i64 = 30 * 86_400;
pub const MIN_ORACLE_AGE: i64 = 1;
pub const MAX_ORACLE_AGE: i64 = 7 * 86_400;
/// The settlement window (§8). At least a minute, so a missed block cannot
/// strand a series; at most four days, so a window opened at a Friday close
/// can reach the next session across a long weekend without ever spanning a
/// whole week of prints.
pub const MIN_PRICE_LAG: i64 = 60;
pub const MAX_PRICE_LAG: i64 = 4 * 86_400;
pub const MAX_FEE_BPS: u16 = 1_000; // 10%

#[program]
pub mod factory {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        factory.admin = ctx.accounts.admin.key();
        factory.paused = false;
        factory.series_count = 0;
        factory.bump = ctx.bumps.factory;
        Ok(())
    }

    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.factory.admin = new_admin;
        Ok(())
    }

    pub fn pause_creation(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.factory.paused = true;
        Ok(())
    }

    pub fn unpause_creation(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.factory.paused = false;
        Ok(())
    }

    /// Allow series to settle against this feed config.
    ///
    /// The existence of the approval account *is* the approval, so revoking is
    /// closing it. Approving a `SourceKind::Mock` feed on mainnet would let
    /// the operator write the price a series settles against; that is what the
    /// pre-deployment checklist in the README exists to catch.
    pub fn approve_oracle(ctx: Context<ApproveOracle>) -> Result<()> {
        let approval = &mut ctx.accounts.approval;
        approval.target = ctx.accounts.feed_config.key();
        approval.bump = ctx.bumps.approval;
        emit!(OracleApproved {
            feed_config: approval.target
        });
        Ok(())
    }

    pub fn revoke_oracle(ctx: Context<RevokeOracle>) -> Result<()> {
        emit!(OracleRevoked {
            feed_config: ctx.accounts.approval.target
        });
        Ok(())
    }

    /// Allow series to escrow this collateral mint.
    pub fn approve_collateral(ctx: Context<ApproveCollateral>) -> Result<()> {
        let approval = &mut ctx.accounts.approval;
        approval.target = ctx.accounts.collateral_mint.key();
        approval.bump = ctx.bumps.approval;
        emit!(CollateralApproved {
            mint: approval.target
        });
        Ok(())
    }

    pub fn revoke_collateral(ctx: Context<RevokeCollateral>) -> Result<()> {
        emit!(CollateralRevoked {
            mint: ctx.accounts.approval.target
        });
        Ok(())
    }

    /// Create a canonical series and register it.
    ///
    /// Validates policy, drives `series::create_series` through a CPI signed by
    /// the factory PDA, and writes the registry record. The `series` program
    /// re-validates everything it cares about independently; nothing here is
    /// load-bearing for the safety of the vault, only for what gets listed.
    pub fn create_series(ctx: Context<CreateSeries>, params: CreateSeriesParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.factory.paused, OptionsError::CreationPaused);
        validate_policy(&params, now)?;

        let bump = ctx.accounts.factory.bump;
        let seeds: &[&[u8]] = &[FACTORY_SEED, &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        series::cpi::create_series(
            CpiContext::new_with_signer(
                ctx.accounts.series_program.to_account_info(),
                series::cpi::accounts::CreateSeries {
                    payer: ctx.accounts.payer.to_account_info(),
                    factory_authority: ctx.accounts.factory.to_account_info(),
                    admin: ctx.accounts.series_admin.to_account_info(),
                    series: ctx.accounts.series.to_account_info(),
                    collateral_mint: ctx.accounts.collateral_mint.to_account_info(),
                    collateral_vault: ctx.accounts.collateral_vault.to_account_info(),
                    oracle_adapter: ctx.accounts.feed_config.to_account_info(),
                    p_mint: ctx.accounts.p_mint.to_account_info(),
                    n_mint: ctx.accounts.n_mint.to_account_info(),
                    fee_recipient: ctx.accounts.fee_recipient.to_account_info(),
                    collateral_token_program: ctx
                        .accounts
                        .collateral_token_program
                        .to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    associated_token_program: ctx
                        .accounts
                        .associated_token_program
                        .to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                signer,
            ),
            params,
        )?;

        let factory = &mut ctx.accounts.factory;
        let index = factory.series_count;
        factory.series_count = index.checked_add(1).ok_or(OptionsError::MathOverflow)?;

        let record = &mut ctx.accounts.record;
        record.series = ctx.accounts.series.key();
        record.collateral_mint = ctx.accounts.collateral_mint.key();
        record.feed_config = ctx.accounts.feed_config.key();
        record.strike = params.strike;
        record.maturity_ts = params.maturity_ts;
        record.price_decimals = params.price_decimals;
        record.index = index;
        record.bump = ctx.bumps.record;

        emit!(SeriesRegistered {
            series: record.series,
            collateral_mint: record.collateral_mint,
            feed_config: record.feed_config,
            strike: record.strike,
            maturity_ts: record.maturity_ts,
            index,
        });
        Ok(())
    }
}

/// Policy bounds the factory adds on top of the series program's own checks.
pub fn validate_policy(params: &CreateSeriesParams, now: i64) -> Result<()> {
    require!(params.strike > 0, OptionsError::InvalidStrike);
    require!(
        params.price_decimals > 0 && params.price_decimals <= MAX_PRICE_DECIMALS,
        OptionsError::InvalidDecimals
    );
    require!(
        params.maturity_ts >= now.saturating_add(MIN_TERM_SECS),
        OptionsError::InvalidMaturity
    );
    require!(
        (0..=MAX_SETTLEMENT_DELAY).contains(&params.settlement_delay_secs),
        OptionsError::InvalidParams
    );
    require!(
        (MIN_ORACLE_AGE..=MAX_ORACLE_AGE).contains(&params.max_oracle_age_secs),
        OptionsError::InvalidParams
    );
    require!(
        (MIN_PRICE_LAG..=MAX_PRICE_LAG).contains(&params.max_price_lag_secs),
        OptionsError::InvalidParams
    );
    require!(
        params.settlement_delay_secs
            <= params
                .max_price_lag_secs
                .checked_add(params.max_oracle_age_secs)
                .ok_or(OptionsError::InvalidParams)?,
        OptionsError::InvalidParams
    );
    require!(params.min_split_amount > 0, OptionsError::InvalidParams);
    require!(params.fee_bps <= MAX_FEE_BPS, OptionsError::InvalidParams);
    Ok(())
}

// --- State ----------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct FactoryState {
    pub admin: Pubkey,
    pub paused: bool,
    pub series_count: u64,
    pub bump: u8,
}

/// An allowlist entry. Existence is the approval; revoking closes the account.
#[account]
#[derive(InitSpace)]
pub struct Approval {
    pub target: Pubkey,
    pub bump: u8,
}

/// The registry entry that makes a series canonical.
#[account]
#[derive(InitSpace)]
pub struct SeriesRecord {
    pub series: Pubkey,
    pub collateral_mint: Pubkey,
    pub feed_config: Pubkey,
    pub strike: i128,
    pub maturity_ts: i64,
    pub price_decimals: u32,
    /// Creation order, for stable listing.
    pub index: u64,
    pub bump: u8,
}

// --- Accounts -------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub admin: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + FactoryState::INIT_SPACE,
        seeds = [FACTORY_SEED],
        bump,
    )]
    pub factory: Account<'info, FactoryState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin, seeds = [FACTORY_SEED], bump = factory.bump)]
    pub factory: Account<'info, FactoryState>,
}

#[derive(Accounts)]
pub struct ApproveOracle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub admin: Signer<'info>,

    #[account(has_one = admin, seeds = [FACTORY_SEED], bump = factory.bump)]
    pub factory: Account<'info, FactoryState>,

    pub feed_config: Account<'info, FeedConfig>,

    #[account(
        init,
        payer = payer,
        space = 8 + Approval::INIT_SPACE,
        seeds = [ORACLE_SEED, feed_config.key().as_ref()],
        bump,
    )]
    pub approval: Account<'info, Approval>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeOracle<'info> {
    pub admin: Signer<'info>,

    #[account(has_one = admin, seeds = [FACTORY_SEED], bump = factory.bump)]
    pub factory: Account<'info, FactoryState>,

    /// CHECK: refunded the approval's rent; not read.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [ORACLE_SEED, approval.target.as_ref()],
        bump = approval.bump,
    )]
    pub approval: Account<'info, Approval>,
}

#[derive(Accounts)]
pub struct ApproveCollateral<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub admin: Signer<'info>,

    #[account(has_one = admin, seeds = [FACTORY_SEED], bump = factory.bump)]
    pub factory: Account<'info, FactoryState>,

    pub collateral_mint: InterfaceAccount<'info, CollateralMint>,

    #[account(
        init,
        payer = payer,
        space = 8 + Approval::INIT_SPACE,
        seeds = [COLLATERAL_SEED, collateral_mint.key().as_ref()],
        bump,
    )]
    pub approval: Account<'info, Approval>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeCollateral<'info> {
    pub admin: Signer<'info>,

    #[account(has_one = admin, seeds = [FACTORY_SEED], bump = factory.bump)]
    pub factory: Account<'info, FactoryState>,

    /// CHECK: refunded the approval's rent; not read.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [COLLATERAL_SEED, approval.target.as_ref()],
        bump = approval.bump,
    )]
    pub approval: Account<'info, Approval>,
}

#[derive(Accounts)]
#[instruction(params: CreateSeriesParams)]
pub struct CreateSeries<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub admin: Signer<'info>,

    #[account(mut, has_one = admin, seeds = [FACTORY_SEED], bump = factory.bump)]
    pub factory: Account<'info, FactoryState>,

    /// CHECK: recorded as the new series' admin by the CPI; never signs here.
    pub series_admin: UncheckedAccount<'info>,

    /// The allowlist entry for the feed. Its existence is the approval, and
    /// its seeds tie it to `feed_config`, so no further check is needed.
    #[account(seeds = [ORACLE_SEED, feed_config.key().as_ref()], bump = oracle_approval.bump)]
    pub oracle_approval: Account<'info, Approval>,

    #[account(
        seeds = [COLLATERAL_SEED, collateral_mint.key().as_ref()],
        bump = collateral_approval.bump,
    )]
    pub collateral_approval: Account<'info, Approval>,

    pub feed_config: Box<Account<'info, FeedConfig>>,

    #[account(mint::token_program = collateral_token_program)]
    pub collateral_mint: Box<InterfaceAccount<'info, CollateralMint>>,

    /// CHECK: initialized and validated by the `series` program's own
    /// `CreateSeries` constraints, which own this PDA.
    #[account(mut)]
    pub series: UncheckedAccount<'info>,

    /// CHECK: as above — the series program creates this ATA.
    #[account(mut)]
    pub collateral_vault: UncheckedAccount<'info>,

    /// CHECK: as above.
    #[account(mut)]
    pub p_mint: UncheckedAccount<'info>,

    /// CHECK: as above.
    #[account(mut)]
    pub n_mint: UncheckedAccount<'info>,

    /// CHECK: recorded as the series' fee and dust recipient; never signs.
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + SeriesRecord::INIT_SPACE,
        seeds = [RECORD_SEED, series.key().as_ref()],
        bump,
    )]
    pub record: Box<Account<'info, SeriesRecord>>,

    pub series_program: Program<'info, SeriesProgram>,
    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// --- Events ---------------------------------------------------------------

#[event]
pub struct OracleApproved {
    pub feed_config: Pubkey,
}

#[event]
pub struct OracleRevoked {
    pub feed_config: Pubkey,
}

#[event]
pub struct CollateralApproved {
    pub mint: Pubkey,
}

#[event]
pub struct CollateralRevoked {
    pub mint: Pubkey,
}

#[event]
pub struct SeriesRegistered {
    pub series: Pubkey,
    pub collateral_mint: Pubkey,
    pub feed_config: Pubkey,
    pub strike: i128,
    pub maturity_ts: i64,
    pub index: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000;

    fn sane() -> CreateSeriesParams {
        CreateSeriesParams {
            strike: 500 * 100_000_000,
            maturity_ts: NOW + 30 * 86_400,
            price_decimals: 8,
            settlement_delay_secs: 600,
            max_oracle_age_secs: 300,
            max_price_lag_secs: 900,
            min_split_amount: 1_000_000,
            fee_bps: 0,
        }
    }

    #[test]
    fn a_sane_series_passes_policy() {
        assert!(validate_policy(&sane(), NOW).is_ok());
    }

    #[test]
    fn policy_rejects_a_series_maturing_too_soon() {
        // A series that matures in a minute leaves no time to sell N, which is
        // the only reason the P holder is doing this.
        let mut p = sane();
        p.maturity_ts = NOW + 60;
        assert!(validate_policy(&p, NOW).is_err());
        p.maturity_ts = NOW + MIN_TERM_SECS;
        assert!(validate_policy(&p, NOW).is_ok());
    }

    #[test]
    fn policy_bounds_the_settlement_window() {
        // §8: too narrow and a missed close strands the series; too wide and
        // the window reaches into a later session's prints.
        let mut p = sane();
        p.max_price_lag_secs = MIN_PRICE_LAG - 1;
        assert!(validate_policy(&p, NOW).is_err());
        p.max_price_lag_secs = MAX_PRICE_LAG + 1;
        assert!(validate_policy(&p, NOW).is_err());
        p.max_price_lag_secs = MAX_PRICE_LAG;
        assert!(validate_policy(&p, NOW).is_ok());
    }

    #[test]
    fn policy_bounds_oracle_staleness() {
        let mut p = sane();
        p.max_oracle_age_secs = 0;
        assert!(validate_policy(&p, NOW).is_err());
        p.max_oracle_age_secs = MAX_ORACLE_AGE + 1;
        assert!(validate_policy(&p, NOW).is_err());
    }

    #[test]
    fn policy_rejects_a_delay_that_outlives_every_eligible_quote() {
        let mut p = sane();
        p.max_price_lag_secs = 900;
        p.max_oracle_age_secs = 300;
        p.settlement_delay_secs = 1_201;
        assert!(validate_policy(&p, NOW).is_err());

        p.settlement_delay_secs = 1_200;
        assert!(validate_policy(&p, NOW).is_ok());
    }

    #[test]
    fn policy_caps_the_fee_below_the_arithmetic_limit() {
        // The series program only rejects a fee above 100%; policy stops well
        // short of that.
        let mut p = sane();
        p.fee_bps = MAX_FEE_BPS;
        assert!(validate_policy(&p, NOW).is_ok());
        p.fee_bps = MAX_FEE_BPS + 1;
        assert!(validate_policy(&p, NOW).is_err());
    }

    #[test]
    fn policy_rejects_incoherent_strikes_and_decimals() {
        let mut p = sane();
        p.strike = 0;
        assert!(validate_policy(&p, NOW).is_err());

        let mut p = sane();
        p.price_decimals = 0;
        assert!(validate_policy(&p, NOW).is_err());
        p.price_decimals = MAX_PRICE_DECIMALS + 1;
        assert!(validate_policy(&p, NOW).is_err());
    }

    #[test]
    fn policy_rejects_a_zero_minimum_split() {
        let mut p = sane();
        p.min_split_amount = 0;
        assert!(validate_policy(&p, NOW).is_err());
    }
}
