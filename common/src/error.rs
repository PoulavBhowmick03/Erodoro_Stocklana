// SPDX-License-Identifier: Apache-2.0
use anchor_lang::prelude::*;

/// Protocol-wide error codes, shared by every program in the workspace so that
/// off-chain tooling decodes failures with one table.
///
/// The ordering is stable and must never change. Off-chain tooling decodes
/// failures against it by position, so inserting a variant anywhere but the
/// end silently reassigns every code after it.
///
/// Note that Anchor adds its own 6000 offset when these surface on-chain: the
/// first variant is reported as 6000, not 1. The ordering is what must never
/// change.
#[error_code]
#[derive(PartialEq, Eq)]
pub enum OptionsError {
    #[msg("already initialized")]
    AlreadyInitialized,
    #[msg("not initialized")]
    NotInitialized,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("amount must be positive")]
    InvalidAmount,
    #[msg("amount below the series minimum")]
    AmountTooSmall,
    #[msg("strike must be positive")]
    InvalidStrike,
    #[msg("maturity must be in the future")]
    InvalidMaturity,
    #[msg("oracle is not approved for this series")]
    InvalidOracle,
    #[msg("collateral mint is not accepted")]
    InvalidCollateral,
    #[msg("series is closed for this operation")]
    SeriesClosed,
    #[msg("series splits are paused")]
    SeriesPaused,
    #[msg("series has not reached maturity")]
    SeriesNotMatured,
    #[msg("settlement delay has not elapsed")]
    SettlementTooEarly,
    #[msg("series is already settled")]
    AlreadySettled,
    #[msg("series is not settled yet")]
    NotSettled,
    #[msg("oracle price is invalid")]
    OraclePriceInvalid,
    #[msg("oracle price is stale")]
    OraclePriceStale,
    #[msg("oracle reports the wrong pair")]
    OraclePairInvalid,
    #[msg("oracle decimals are out of range")]
    OracleDecimalsInvalid,
    #[msg("P and N supplies do not match")]
    SupplyMismatch,
    #[msg("vault holds less collateral than outstanding claims")]
    InsufficientCollateral,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("arithmetic underflow")]
    MathUnderflow,
    #[msg("division by zero")]
    DivisionByZero,
    #[msg("dust sweep requires both supplies to be zero")]
    DustSweepTooEarly,
    #[msg("decimals out of range")]
    InvalidDecimals,
    #[msg("invalid parameters")]
    InvalidParams,
    #[msg("series creation is paused")]
    CreationPaused,
    #[msg("series already exists")]
    SeriesExists,
    #[msg("series not found")]
    SeriesNotFound,
    #[msg("insufficient balance")]
    InsufficientBalance,
    #[msg("allowance expired")]
    AllowanceExpired,

    // --- New to the Solana port ------------------------------------------
    #[msg("scaled UI amount multiplier is zero or unreadable")]
    MultiplierInvalid,
    #[msg("a multiplier change is scheduled to land before maturity")]
    MultiplierChangeScheduled,
    #[msg("quote was printed outside the series' settlement window")]
    MarketClosed,
    #[msg("oracle feed identity does not match the series config")]
    FeedMismatch,
    #[msg("collateral mint decimals do not match the series config")]
    CollateralDecimalsMismatch,
}
