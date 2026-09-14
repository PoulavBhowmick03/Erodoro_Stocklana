// SPDX-License-Identifier: Apache-2.0
//! Anchor-compatible events.
//!
//! `emit!` compiles to `sol_log_data(&[&Event::data(&e)])`, where `data()` is
//! `sha256("event:<Name>")[..8]` followed by the borsh body. The runtime
//! base64-encodes that into a `Program data:` line, which is what every client
//! event parser reads — so reproducing the bytes exactly is what keeps a
//! listener built against the Anchor IDL working against this build.
//!
//! All nine bodies are fixed width, so each is assembled in a stack array.
//! Discriminators are derived in `tests/events_wire.rs`, not trusted here.
//! Each event has a pure `*_data` constructor (asserted byte-equal to Anchor's
//! `Event::data`) plus the thin emitter the handlers call.

pub const SERIES_CREATED_DISC: [u8; 8] = [2, 164, 54, 38, 24, 181, 233, 180];
pub const SPLIT_EXECUTED_DISC: [u8; 8] = [147, 176, 193, 145, 52, 30, 166, 53];
pub const MERGE_EXECUTED_DISC: [u8; 8] = [212, 9, 237, 250, 181, 177, 71, 244];
pub const SERIES_SETTLED_DISC: [u8; 8] = [119, 185, 208, 158, 40, 59, 197, 235];
pub const REDEEMED_DISC: [u8; 8] = [14, 29, 183, 71, 31, 165, 107, 38];
pub const SHORTFALL_OBSERVED_DISC: [u8; 8] = [238, 147, 218, 208, 7, 95, 60, 79];
pub const SPLITS_PAUSED_DISC: [u8; 8] = [94, 82, 132, 197, 189, 72, 80, 87];
pub const ADMIN_RENOUNCED_DISC: [u8; 8] = [179, 238, 157, 220, 250, 72, 118, 99];
pub const DUST_SWEPT_DISC: [u8; 8] = [131, 70, 179, 205, 208, 80, 13, 168];

/// `sol_log_data` takes an array of slice descriptors and a count. A `&[&[u8]]`
/// already has that layout, so one is passed straight through — the same
/// single-slice shape `emit!` produces.
#[inline]
fn log_data(payload: &[u8]) {
    #[cfg(target_os = "solana")]
    {
        let slices: [&[u8]; 1] = [payload];
        unsafe {
            pinocchio::syscalls::sol_log_data(slices.as_ptr() as *const u8, slices.len() as u64);
        }
    }
    #[cfg(not(target_os = "solana"))]
    let _ = payload;
}

/// A stack writer, so nothing here allocates.
struct Body<const N: usize> {
    bytes: [u8; N],
    at: usize,
}

impl<const N: usize> Body<N> {
    fn new(disc: &[u8; 8]) -> Self {
        let mut body = Self {
            bytes: [0u8; N],
            at: 0,
        };
        body.put(disc);
        body
    }

    fn put(&mut self, src: &[u8]) {
        let end = self.at + src.len();
        self.bytes[self.at..end].copy_from_slice(src);
        self.at = end;
    }

    fn put_u64(&mut self, value: u64) {
        self.put(&value.to_le_bytes());
    }

    fn put_i64(&mut self, value: i64) {
        self.put(&value.to_le_bytes());
    }

    fn put_u32(&mut self, value: u32) {
        self.put(&value.to_le_bytes());
    }

    fn put_i128(&mut self, value: i128) {
        self.put(&value.to_le_bytes());
    }

    fn put_bool(&mut self, value: bool) {
        self.put(&[value as u8]);
    }

    fn finish(self) -> [u8; N] {
        self.bytes
    }
}

/// `SeriesCreated`: series, collateral mint, P/N mints, strike, decimals,
/// maturity and the creation multiplier.
pub fn series_created_data(
    series: &[u8; 32],
    collateral_mint: &[u8; 32],
    p_mint: &[u8; 32],
    n_mint: &[u8; 32],
    strike: i128,
    price_decimals: u32,
    maturity_ts: i64,
    multiplier_at_creation: i128,
) -> [u8; 180] {
    let mut body = Body::<180>::new(&SERIES_CREATED_DISC);
    body.put(series);
    body.put(collateral_mint);
    body.put(p_mint);
    body.put(n_mint);
    body.put_i128(strike);
    body.put_u32(price_decimals);
    body.put_i64(maturity_ts);
    body.put_i128(multiplier_at_creation);
    body.finish()
}

pub fn series_created(
    series: &[u8; 32],
    collateral_mint: &[u8; 32],
    p_mint: &[u8; 32],
    n_mint: &[u8; 32],
    strike: i128,
    price_decimals: u32,
    maturity_ts: i64,
    multiplier_at_creation: i128,
) {
    log_data(&series_created_data(
        series,
        collateral_mint,
        p_mint,
        n_mint,
        strike,
        price_decimals,
        maturity_ts,
        multiplier_at_creation,
    ));
}

/// `SplitExecuted`: series, holder, deposited, minted, fee.
pub fn split_executed_data(
    series: &[u8; 32],
    holder: &[u8; 32],
    deposited: u64,
    minted: u64,
    fee: u64,
) -> [u8; 96] {
    let mut body = Body::<96>::new(&SPLIT_EXECUTED_DISC);
    body.put(series);
    body.put(holder);
    body.put_u64(deposited);
    body.put_u64(minted);
    body.put_u64(fee);
    body.finish()
}

pub fn split_executed(series: &[u8; 32], holder: &[u8; 32], deposited: u64, minted: u64, fee: u64) {
    log_data(&split_executed_data(series, holder, deposited, minted, fee));
}

/// `MergeExecuted`: series, holder, amount.
pub fn merge_executed_data(series: &[u8; 32], holder: &[u8; 32], amount: u64) -> [u8; 80] {
    let mut body = Body::<80>::new(&MERGE_EXECUTED_DISC);
    body.put(series);
    body.put(holder);
    body.put_u64(amount);
    body.finish()
}

pub fn merge_executed(series: &[u8; 32], holder: &[u8; 32], amount: u64) {
    log_data(&merge_executed_data(series, holder, amount));
}

/// `SeriesSettled`: the frozen result, in field order.
#[allow(clippy::too_many_arguments)]
pub fn series_settled_data(
    series: &[u8; 32],
    price: i128,
    price_decimals: u32,
    price_ts: i64,
    collateral: u64,
    p_pool: u64,
    n_pool: u64,
    effective_strike: i128,
    multiplier_at_creation: i128,
    multiplier_at_settlement: i128,
    supply_mismatch: bool,
    under_collateralized: bool,
) -> [u8; 142] {
    let mut body = Body::<142>::new(&SERIES_SETTLED_DISC);
    body.put(series);
    body.put_i128(price);
    body.put_u32(price_decimals);
    body.put_i64(price_ts);
    body.put_u64(collateral);
    body.put_u64(p_pool);
    body.put_u64(n_pool);
    body.put_i128(effective_strike);
    body.put_i128(multiplier_at_creation);
    body.put_i128(multiplier_at_settlement);
    body.put_bool(supply_mismatch);
    body.put_bool(under_collateralized);
    body.finish()
}

#[allow(clippy::too_many_arguments)]
pub fn series_settled(
    series: &[u8; 32],
    price: i128,
    price_decimals: u32,
    price_ts: i64,
    collateral: u64,
    p_pool: u64,
    n_pool: u64,
    effective_strike: i128,
    multiplier_at_creation: i128,
    multiplier_at_settlement: i128,
    supply_mismatch: bool,
    under_collateralized: bool,
) {
    log_data(&series_settled_data(
        series,
        price,
        price_decimals,
        price_ts,
        collateral,
        p_pool,
        n_pool,
        effective_strike,
        multiplier_at_creation,
        multiplier_at_settlement,
        supply_mismatch,
        under_collateralized,
    ));
}

/// `Redeemed` plus, when the vault came up short, `ShortfallObserved`.
pub fn redeemed_data(
    series: &[u8; 32],
    holder: &[u8; 32],
    is_p_side: bool,
    burned: u64,
    quoted: u64,
    paid: u64,
) -> [u8; 97] {
    let mut body = Body::<97>::new(&REDEEMED_DISC);
    body.put(series);
    body.put(holder);
    body.put_bool(is_p_side);
    body.put_u64(burned);
    body.put_u64(quoted);
    body.put_u64(paid);
    body.finish()
}

pub fn redeemed(
    series: &[u8; 32],
    holder: &[u8; 32],
    is_p_side: bool,
    burned: u64,
    quoted: u64,
    paid: u64,
) {
    log_data(&redeemed_data(series, holder, is_p_side, burned, quoted, paid));
}

pub fn shortfall_observed_data(series: &[u8; 32], quoted: u64, paid: u64) -> [u8; 56] {
    let mut body = Body::<56>::new(&SHORTFALL_OBSERVED_DISC);
    body.put(series);
    body.put_u64(quoted);
    body.put_u64(paid);
    body.finish()
}

pub fn shortfall_observed(series: &[u8; 32], quoted: u64, paid: u64) {
    log_data(&shortfall_observed_data(series, quoted, paid));
}

pub fn splits_paused_data(series: &[u8; 32], paused: bool) -> [u8; 41] {
    let mut body = Body::<41>::new(&SPLITS_PAUSED_DISC);
    body.put(series);
    body.put_bool(paused);
    body.finish()
}

pub fn splits_paused(series: &[u8; 32], paused: bool) {
    log_data(&splits_paused_data(series, paused));
}

pub fn admin_renounced_data(series: &[u8; 32]) -> [u8; 40] {
    let mut body = Body::<40>::new(&ADMIN_RENOUNCED_DISC);
    body.put(series);
    body.finish()
}

pub fn admin_renounced(series: &[u8; 32]) {
    log_data(&admin_renounced_data(series));
}

pub fn dust_swept_data(series: &[u8; 32], amount: u64) -> [u8; 48] {
    let mut body = Body::<48>::new(&DUST_SWEPT_DISC);
    body.put(series);
    body.put_u64(amount);
    body.finish()
}

pub fn dust_swept(series: &[u8; 32], amount: u64) {
    log_data(&dust_swept_data(series, amount));
}
