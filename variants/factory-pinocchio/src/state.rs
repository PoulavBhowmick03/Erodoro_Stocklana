// SPDX-License-Identifier: Apache-2.0
//! Account layouts, byte-compatible with the Anchor build.
//!
//! Anchor writes `sha256("account:<Name>")[..8]` ahead of the borsh body and
//! sizes the account as `8 + InitSpace`. An account written by either build has
//! to be readable by the other, so both the discriminator and every field
//! offset are fixed here -- and derived in `tests/conformance.rs` rather than
//! trusted as the literals they appear to be below.

use crate::error::OptionsError;

/// Anchor's account discriminator width.
pub const DISCRIMINATOR_LEN: usize = 8;

pub const FACTORY_SEED: &[u8] = b"factory";
pub const ORACLE_SEED: &[u8] = b"approved-oracle";
pub const COLLATERAL_SEED: &[u8] = b"approved-collateral";
pub const RECORD_SEED: &[u8] = b"record";

pub const FACTORY_STATE_DISC: [u8; 8] = [91, 157, 184, 99, 123, 112, 102, 7];
pub const APPROVAL_DISC: [u8; 8] = [233, 9, 153, 49, 11, 222, 59, 130];
pub const SERIES_RECORD_DISC: [u8; 8] = [108, 124, 7, 20, 121, 5, 39, 176];

/// 8 + (32 admin + 1 paused + 8 series_count + 1 bump).
pub const FACTORY_STATE_LEN: usize = 8 + 42;
/// 8 + (32 target + 1 bump).
pub const APPROVAL_LEN: usize = 8 + 33;
/// 8 + (32 + 32 + 32 + 16 + 8 + 4 + 8 + 1).
pub const SERIES_RECORD_LEN: usize = 8 + 133;

/// Read a fixed-width field, advancing the cursor.
macro_rules! take {
    ($src:expr, $cursor:expr, $ty:ty, $n:literal) => {{
        let end = $cursor + $n;
        let mut buf = [0u8; $n];
        buf.copy_from_slice(&$src[$cursor..end]);
        $cursor = end;
        <$ty>::from_le_bytes(buf)
    }};
}

macro_rules! take_key {
    ($src:expr, $cursor:expr) => {{
        let end = $cursor + 32;
        let mut buf = [0u8; 32];
        buf.copy_from_slice(&$src[$cursor..end]);
        $cursor = end;
        buf
    }};
}

/// Check and strip the discriminator. Anchor's `Account<'info, T>` does this
/// before it will hand out a `T`, and it is half of what stops one account
/// type being read as another.
fn strip<'a>(data: &'a [u8], disc: &[u8; 8], min: usize) -> Result<&'a [u8], OptionsError> {
    if data.len() < min {
        return Err(OptionsError::InvalidParams);
    }
    if &data[..DISCRIMINATOR_LEN] != disc {
        return Err(OptionsError::InvalidParams);
    }
    Ok(&data[DISCRIMINATOR_LEN..])
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FactoryState {
    pub admin: [u8; 32],
    pub paused: bool,
    pub series_count: u64,
    pub bump: u8,
}

impl FactoryState {
    pub fn load(data: &[u8]) -> Result<Self, OptionsError> {
        let body = strip(data, &FACTORY_STATE_DISC, FACTORY_STATE_LEN)?;
        let mut c = 0usize;
        let admin = take_key!(body, c);
        let paused = body[c] != 0;
        c += 1;
        let series_count = take!(body, c, u64, 8);
        let bump = body[c];
        Ok(Self {
            admin,
            paused,
            series_count,
            bump,
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), OptionsError> {
        if data.len() < FACTORY_STATE_LEN {
            return Err(OptionsError::InvalidParams);
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&FACTORY_STATE_DISC);
        let body = &mut data[DISCRIMINATOR_LEN..];
        body[..32].copy_from_slice(&self.admin);
        body[32] = self.paused as u8;
        body[33..41].copy_from_slice(&self.series_count.to_le_bytes());
        body[41] = self.bump;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Approval {
    pub target: [u8; 32],
    pub bump: u8,
}

impl Approval {
    pub fn load(data: &[u8]) -> Result<Self, OptionsError> {
        let body = strip(data, &APPROVAL_DISC, APPROVAL_LEN)?;
        let mut c = 0usize;
        let target = take_key!(body, c);
        Ok(Self {
            target,
            bump: body[c],
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), OptionsError> {
        if data.len() < APPROVAL_LEN {
            return Err(OptionsError::InvalidParams);
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&APPROVAL_DISC);
        let body = &mut data[DISCRIMINATOR_LEN..];
        body[..32].copy_from_slice(&self.target);
        body[32] = self.bump;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SeriesRecord {
    pub series: [u8; 32],
    pub collateral_mint: [u8; 32],
    pub feed_config: [u8; 32],
    pub strike: i128,
    pub maturity_ts: i64,
    pub price_decimals: u32,
    pub index: u64,
    pub bump: u8,
}

impl SeriesRecord {
    pub fn load(data: &[u8]) -> Result<Self, OptionsError> {
        let body = strip(data, &SERIES_RECORD_DISC, SERIES_RECORD_LEN)?;
        let mut c = 0usize;
        let series = take_key!(body, c);
        let collateral_mint = take_key!(body, c);
        let feed_config = take_key!(body, c);
        Ok(Self {
            series,
            collateral_mint,
            feed_config,
            strike: take!(body, c, i128, 16),
            maturity_ts: take!(body, c, i64, 8),
            price_decimals: take!(body, c, u32, 4),
            index: take!(body, c, u64, 8),
            bump: body[c],
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), OptionsError> {
        if data.len() < SERIES_RECORD_LEN {
            return Err(OptionsError::InvalidParams);
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&SERIES_RECORD_DISC);
        let body = &mut data[DISCRIMINATOR_LEN..];
        let mut c = 0usize;
        let mut put = |bytes: &[u8]| {
            body[c..c + bytes.len()].copy_from_slice(bytes);
            c += bytes.len();
        };
        put(&self.series);
        put(&self.collateral_mint);
        put(&self.feed_config);
        put(&self.strike.to_le_bytes());
        put(&self.maturity_ts.to_le_bytes());
        put(&self.price_decimals.to_le_bytes());
        put(&self.index.to_le_bytes());
        put(&[self.bump]);
        Ok(())
    }
}
