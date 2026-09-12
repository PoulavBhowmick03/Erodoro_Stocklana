// SPDX-License-Identifier: Apache-2.0
//! `CreateSeriesParams` and the policy bounds the factory adds on top of the
//! series program's own checks.
//!
//! Every field is fixed width, so borsh here is a cursor walk rather than a
//! derive. The encoding has to round-trip exactly: these same bytes are handed
//! straight back to `series::create_series` over a CPI, so a layout slip would
//! not fail locally, it would build a different series than the caller asked
//! for.

use crate::error::OptionsError;

/// Wire size of a borsh-encoded `CreateSeriesParams`: 16 + 8 + 4 + 8 + 8 + 8 +
/// 8 + 2.
pub const CREATE_SERIES_PARAMS_LEN: usize = 62;

// Parameter bounds enforced at creation. These are policy, not arithmetic --
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

macro_rules! take {
    ($src:expr, $cursor:expr, $ty:ty, $n:literal) => {{
        let end = $cursor + $n;
        let mut buf = [0u8; $n];
        buf.copy_from_slice(&$src[$cursor..end]);
        $cursor = end;
        <$ty>::from_le_bytes(buf)
    }};
}

impl CreateSeriesParams {
    /// Decode from borsh. Rejects anything shorter than the fixed width;
    /// trailing bytes are tolerated, matching what borsh does for a struct of
    /// fixed-width fields.
    // The cursor's final advance is never read -- the last field ends the
    // struct. Keeping the macro uniform is worth more than the one dead store.
    #[allow(unused_assignments)]
    pub fn decode(data: &[u8]) -> Result<Self, OptionsError> {
        if data.len() < CREATE_SERIES_PARAMS_LEN {
            return Err(OptionsError::InvalidParams);
        }
        let mut c = 0usize;
        Ok(Self {
            strike: take!(data, c, i128, 16),
            maturity_ts: take!(data, c, i64, 8),
            price_decimals: take!(data, c, u32, 4),
            settlement_delay_secs: take!(data, c, i64, 8),
            max_oracle_age_secs: take!(data, c, i64, 8),
            max_price_lag_secs: take!(data, c, i64, 8),
            min_split_amount: take!(data, c, u64, 8),
            fee_bps: take!(data, c, u16, 2),
        })
    }

    /// Re-encode for the CPI into `series`.
    pub fn encode(&self) -> [u8; CREATE_SERIES_PARAMS_LEN] {
        let mut out = [0u8; CREATE_SERIES_PARAMS_LEN];
        let mut c = 0usize;
        let mut put = |bytes: &[u8]| {
            out[c..c + bytes.len()].copy_from_slice(bytes);
            c += bytes.len();
        };
        put(&self.strike.to_le_bytes());
        put(&self.maturity_ts.to_le_bytes());
        put(&self.price_decimals.to_le_bytes());
        put(&self.settlement_delay_secs.to_le_bytes());
        put(&self.max_oracle_age_secs.to_le_bytes());
        put(&self.max_price_lag_secs.to_le_bytes());
        put(&self.min_split_amount.to_le_bytes());
        put(&self.fee_bps.to_le_bytes());
        debug_assert_eq!(c, CREATE_SERIES_PARAMS_LEN);
        out
    }
}

/// Policy bounds the factory adds on top of the series program's own checks.
///
/// Mirrors `factory::validate_policy` condition for condition, *in the same
/// order* -- a caller passing several bad parameters at once must get the same
/// error code from either build, and the order is what decides which one wins.
pub fn validate_policy(params: &CreateSeriesParams, now: i64) -> Result<(), OptionsError> {
    if params.strike <= 0 {
        return Err(OptionsError::InvalidStrike);
    }
    if !(params.price_decimals > 0 && params.price_decimals <= MAX_PRICE_DECIMALS) {
        return Err(OptionsError::InvalidDecimals);
    }
    if params.maturity_ts < now.saturating_add(MIN_TERM_SECS) {
        return Err(OptionsError::InvalidMaturity);
    }
    if !(0..=MAX_SETTLEMENT_DELAY).contains(&params.settlement_delay_secs) {
        return Err(OptionsError::InvalidParams);
    }
    if !(MIN_ORACLE_AGE..=MAX_ORACLE_AGE).contains(&params.max_oracle_age_secs) {
        return Err(OptionsError::InvalidParams);
    }
    if !(MIN_PRICE_LAG..=MAX_PRICE_LAG).contains(&params.max_price_lag_secs) {
        return Err(OptionsError::InvalidParams);
    }
    let window = params
        .max_price_lag_secs
        .checked_add(params.max_oracle_age_secs)
        .ok_or(OptionsError::InvalidParams)?;
    if params.settlement_delay_secs > window {
        return Err(OptionsError::InvalidParams);
    }
    if params.min_split_amount == 0 {
        return Err(OptionsError::InvalidParams);
    }
    if params.fee_bps > MAX_FEE_BPS {
        return Err(OptionsError::InvalidParams);
    }
    Ok(())
}
