// SPDX-License-Identifier: Apache-2.0
//! Anchor-compatible events.
//!
//! `emit!` compiles to `sol_log_data(&[&Event::data(&e)])`, where `data()` is
//! `sha256("event:<Name>")[..8]` followed by the borsh body. The runtime
//! base64-encodes that into a `Program data:` line, which is what every client
//! event parser reads. Reproducing the bytes exactly is what keeps a listener
//! built against the Anchor IDL working against this build.

use crate::state::SeriesRecord;

pub const ORACLE_APPROVED_DISC: [u8; 8] = [217, 28, 133, 15, 170, 30, 218, 224];
pub const ORACLE_REVOKED_DISC: [u8; 8] = [46, 163, 216, 49, 163, 153, 239, 118];
pub const COLLATERAL_APPROVED_DISC: [u8; 8] = [60, 125, 99, 169, 203, 104, 234, 67];
pub const COLLATERAL_REVOKED_DISC: [u8; 8] = [60, 16, 213, 190, 23, 161, 154, 117];
pub const SERIES_REGISTERED_DISC: [u8; 8] = [86, 144, 81, 8, 158, 119, 149, 174];

/// `sol_log_data` takes an array of slice descriptors and a count. A
/// `&[&[u8]]` already has that layout, so one is passed straight through --
/// the same single-slice shape `emit!` produces.
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

/// The four single-pubkey events share a body: 8-byte discriminator, 32-byte
/// key, nothing else.
#[inline]
fn emit_key(disc: &[u8; 8], key: &[u8; 32]) {
    let mut buf = [0u8; 40];
    buf[..8].copy_from_slice(disc);
    buf[8..].copy_from_slice(key);
    log_data(&buf);
}

pub fn oracle_approved(feed_config: &[u8; 32]) {
    emit_key(&ORACLE_APPROVED_DISC, feed_config);
}

pub fn oracle_revoked(feed_config: &[u8; 32]) {
    emit_key(&ORACLE_REVOKED_DISC, feed_config);
}

pub fn collateral_approved(mint: &[u8; 32]) {
    emit_key(&COLLATERAL_APPROVED_DISC, mint);
}

pub fn collateral_revoked(mint: &[u8; 32]) {
    emit_key(&COLLATERAL_REVOKED_DISC, mint);
}

/// Body: series ++ collateral_mint ++ feed_config ++ strike ++ maturity_ts ++
/// index. Note this is *not* the `SeriesRecord` layout -- the event omits
/// `price_decimals` and `bump`, and carries the fields in its own order.
pub const SERIES_REGISTERED_LEN: usize = 8 + 32 * 3 + 16 + 8 + 8;

pub fn series_registered(record: &SeriesRecord) {
    let mut buf = [0u8; SERIES_REGISTERED_LEN];
    let mut c = 0usize;
    {
        let mut put = |bytes: &[u8]| {
            buf[c..c + bytes.len()].copy_from_slice(bytes);
            c += bytes.len();
        };
        put(&SERIES_REGISTERED_DISC);
        put(&record.series);
        put(&record.collateral_mint);
        put(&record.feed_config);
        put(&record.strike.to_le_bytes());
        put(&record.maturity_ts.to_le_bytes());
        put(&record.index.to_le_bytes());
    }
    log_data(&buf);
}
