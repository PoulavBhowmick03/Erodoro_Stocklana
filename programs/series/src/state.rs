// SPDX-License-Identifier: Apache-2.0
//! Account layouts for one option series.
//!
//! Everything in [`SeriesConfig`] except the status is immutable for the life
//! of the series; [`Settlement`] is written once and then only its redemption
//! counters move.

use anchor_lang::prelude::*;
use common::SeriesStatus;

/// Configuration of one series, fixed at creation.
///
/// Everything here except [`Self::status`] is immutable for the life of the
/// series. In particular the strike, maturity, oracle and collateral mint are
/// permanent. That is non-negotiable.
#[account]
#[derive(InitSpace)]
pub struct SeriesConfig {
    /// Whoever created this series. The factory sets itself here; a series
    /// created outside the factory records its creator. It confers no
    /// authority — it exists so the canonical registry can be cross-checked.
    pub factory: Pubkey,
    /// May pause and unpause splits, and sweep dust once every claim token is
    /// redeemed. Deliberately has no path to active collateral.
    pub admin: Pubkey,
    /// The Token-2022 mint being escrowed.
    pub collateral_mint: Pubkey,
    /// The series' associated token account.
    pub collateral_vault: Pubkey,
    /// `oracle_adapter::FeedConfig` pinning which feed may settle this series.
    pub oracle_adapter: Pubkey,
    pub p_mint: Pubkey,
    pub n_mint: Pubkey,
    /// Strike in USD, expressed with `price_decimals`. Never mutated — a
    /// corporate action is applied by deriving an effective strike at
    /// settlement, not by rewriting this.
    pub strike: i128,
    /// Decimals shared by `strike` and the normalized oracle price.
    pub price_decimals: u32,
    /// decimals of the collateral mint, captured at creation and passed
    /// to every `transfer_checked`. 8 for TSLAx.
    pub collateral_decimals: u8,
    /// §6: the mint's `scaledUiAmount` multiplier when the series was
    /// created, as a `MULTIPLIER_SCALE` fixed-point integer. Settlement
    /// compares it against the multiplier in force at the price timestamp to
    /// derive the effective strike.
    pub multiplier_at_creation: i128,
    /// Unix timestamp at which the option matures. Should be placed at a real
    /// market close; see `max_price_lag_secs`.
    pub maturity_ts: i64,
    /// Seconds after maturity before `settle` is callable.
    pub settlement_delay_secs: i64,
    /// Maximum accepted oracle staleness relative to the cluster clock.
    pub max_oracle_age_secs: i64,
    /// §8: how far after `maturity_ts` an acceptable price print may
    /// sit. With `maturity_ts` placed at a market close, this bounds how far
    /// settlement may drift from that close. It does not prove that the
    /// underlying market was open; Pyth does not publish that status on-chain.
    pub max_price_lag_secs: i64,
    /// Minimum deposit per split, in raw collateral units.
    pub min_split_amount: u64,
    /// Fee in basis points. `0` for V1.
    pub fee_bps: u16,
    /// Recipient of fees and swept dust.
    pub fee_recipient: Pubkey,
    pub status: SeriesStatus,
    pub bump: u8,
}

/// Frozen settlement result. Written once by `settle`; afterwards only the
/// running redemption counters change.
#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub series: Pubkey,
    /// Final price, normalized to `price_decimals`.
    pub price: i128,
    pub price_decimals: u32,
    /// Publish time of the quote settled against.
    pub price_ts: i64,
    /// Cluster time when settlement executed.
    pub settled_ts: i64,
    /// Vault balance captured at settlement.
    pub collateral_at_settlement: u64,
    pub p_supply_at_settlement: u64,
    pub n_supply_at_settlement: u64,
    /// Collateral allocated to the P side. Immutable after settlement.
    pub p_pool: u64,
    /// Collateral allocated to the N side. Immutable after settlement.
    pub n_pool: u64,
    /// Quoted claim retired by P redeemers so far.
    ///
    /// This tracks the *pro-rata claim*, not the amount actually transferred,
    /// so that the outstanding obligation stays correct under a shortfall and
    /// every redeemer sees the same ratio (§7). `p_redeemed <= p_pool` is the
    /// invariant.
    pub p_redeemed: u64,
    pub n_redeemed: u64,
    /// §7: collateral actually paid out, which is less than the quoted
    /// claim whenever the issuer has drained the vault. Kept alongside
    /// `p_redeemed` so a haircut is auditable after the fact rather than
    /// inferred from the difference between two other numbers.
    pub p_paid: u64,
    pub n_paid: u64,
    /// §6: the multiplier in force at `price_ts`.
    pub multiplier_at_settlement: i128,
    /// §6: the strike actually used, derived from the stored strike and
    /// the two multipliers. Stored so any payout can be audited later.
    pub effective_strike: i128,
    /// §7: set once the vault has ever been observed holding less than
    /// it owes — at settlement, or at any redemption after it.
    pub shortfall_observed: bool,
    /// the claim supplies disagreed at settlement, meaning someone
    /// burned P or N outside the protocol. Recorded rather than rejected,
    /// because rejecting it would let anyone strand a series permanently.
    pub supply_mismatch: bool,
    pub bump: u8,
}

impl Settlement {
    /// Quoted claim still outstanding across both sides — the denominator of
    /// the shortfall haircut.
    pub fn outstanding(&self) -> u64 {
        (self.p_pool.saturating_sub(self.p_redeemed))
            .saturating_add(self.n_pool.saturating_sub(self.n_redeemed))
    }
}
