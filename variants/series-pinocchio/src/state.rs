// SPDX-License-Identifier: Apache-2.0
//! Account layouts for one series, byte-compatible with the Anchor build.
//!
//! Anchor writes `sha256("account:<Name>")[..8]` ahead of the borsh body and
//! sizes the account as `8 + InitSpace`. An account written by either build has
//! to be readable by the other, so both the discriminator and every field
//! offset are fixed here — and derived in `tests/conformance.rs` rather than
//! trusted as the literals they appear to be below.
//!
//! Every field is fixed width, so decoding is a cursor walk rather than a
//! derive.

use common::OptionsError;

pub const DISCRIMINATOR_LEN: usize = 8;

pub const SERIES_SEED: &[u8] = b"series";
pub const P_MINT_SEED: &[u8] = b"p-mint";
pub const N_MINT_SEED: &[u8] = b"n-mint";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

pub const SERIES_CONFIG_DISC: [u8; 8] = [251, 96, 115, 130, 218, 124, 91, 41];
pub const SETTLEMENT_DISC: [u8; 8] = [55, 11, 219, 33, 36, 136, 40, 182];

/// `8 + InitSpace`. Seven pubkeys, the strike, the decimals, the multiplier,
/// four timestamps, the minimum, the fee, the recipient, the status tag and the
/// bump.
pub const SERIES_CONFIG_LEN: usize =
    DISCRIMINATOR_LEN + 32 * 7 + 16 + 4 + 1 + 16 + 8 * 4 + 8 + 2 + 32 + 1 + 1;
/// `8 + InitSpace`. One pubkey, the price and its decimals, two timestamps,
/// nine counters, two i128s, two flags and the bump.
pub const SETTLEMENT_LEN: usize =
    DISCRIMINATOR_LEN + 32 + 16 + 4 + 8 * 2 + 8 * 9 + 16 * 2 + 1 + 1 + 1;

/// Lifecycle status. Borsh writes a fieldless enum as a one-byte tag.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeriesStatus {
    Open,
    Paused,
    Settled,
}

impl SeriesStatus {
    pub fn tag(&self) -> u8 {
        match self {
            SeriesStatus::Open => 0,
            SeriesStatus::Paused => 1,
            SeriesStatus::Settled => 2,
        }
    }

    pub fn from_tag(tag: u8) -> Result<Self, OptionsError> {
        match tag {
            0 => Ok(SeriesStatus::Open),
            1 => Ok(SeriesStatus::Paused),
            2 => Ok(SeriesStatus::Settled),
            // Borsh rejects an out-of-range enum tag; so does this.
            _ => Err(OptionsError::InvalidParams),
        }
    }
}

/// A cursor over a borsh body, so every read is bounds-checked once.
pub struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], OptionsError> {
        let end = self.at.checked_add(n).ok_or(OptionsError::MathOverflow)?;
        if end > self.data.len() {
            return Err(OptionsError::InvalidParams);
        }
        let out = &self.data[self.at..end];
        self.at = end;
        Ok(out)
    }

    pub fn u8(&mut self) -> Result<u8, OptionsError> {
        Ok(self.take(1)?[0])
    }

    pub fn bool(&mut self) -> Result<bool, OptionsError> {
        Ok(self.u8()? != 0)
    }

    pub fn u16(&mut self) -> Result<u16, OptionsError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> Result<u32, OptionsError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u64(&mut self) -> Result<u64, OptionsError> {
        let b = self.take(8)?;
        let mut buf = [0u8; 8];
        buf.copy_from_slice(b);
        Ok(u64::from_le_bytes(buf))
    }

    pub fn i64(&mut self) -> Result<i64, OptionsError> {
        Ok(self.u64()? as i64)
    }

    pub fn i128(&mut self) -> Result<i128, OptionsError> {
        let b = self.take(16)?;
        let mut buf = [0u8; 16];
        buf.copy_from_slice(b);
        Ok(i128::from_le_bytes(buf))
    }

    pub fn key(&mut self) -> Result<[u8; 32], OptionsError> {
        let b = self.take(32)?;
        let mut buf = [0u8; 32];
        buf.copy_from_slice(b);
        Ok(buf)
    }
}

/// A cursor that writes, mirroring [`Cursor`].
pub struct Writer<'a> {
    data: &'a mut [u8],
    at: usize,
}

impl<'a> Writer<'a> {
    pub fn new(data: &'a mut [u8]) -> Self {
        Self { data, at: 0 }
    }

    pub fn put(&mut self, bytes: &[u8]) -> Result<(), OptionsError> {
        let end = self
            .at
            .checked_add(bytes.len())
            .ok_or(OptionsError::MathOverflow)?;
        if end > self.data.len() {
            return Err(OptionsError::InvalidParams);
        }
        self.data[self.at..end].copy_from_slice(bytes);
        self.at = end;
        Ok(())
    }
}

fn strip<'a>(data: &'a [u8], disc: &[u8; 8], min: usize) -> Result<&'a [u8], OptionsError> {
    if data.len() < min || data[..DISCRIMINATOR_LEN] != *disc {
        return Err(OptionsError::InvalidParams);
    }
    Ok(&data[DISCRIMINATOR_LEN..])
}

/// Configuration of one series, fixed at creation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SeriesConfig {
    pub factory: [u8; 32],
    pub admin: [u8; 32],
    pub collateral_mint: [u8; 32],
    pub collateral_vault: [u8; 32],
    pub oracle_adapter: [u8; 32],
    pub p_mint: [u8; 32],
    pub n_mint: [u8; 32],
    pub strike: i128,
    pub price_decimals: u32,
    pub collateral_decimals: u8,
    pub multiplier_at_creation: i128,
    pub maturity_ts: i64,
    pub settlement_delay_secs: i64,
    pub max_oracle_age_secs: i64,
    pub max_price_lag_secs: i64,
    pub min_split_amount: u64,
    pub fee_bps: u16,
    pub fee_recipient: [u8; 32],
    pub status: SeriesStatus,
    pub bump: u8,
}

impl SeriesConfig {
    pub fn load(data: &[u8]) -> Result<Self, OptionsError> {
        let body = strip(data, &SERIES_CONFIG_DISC, SERIES_CONFIG_LEN)?;
        let mut c = Cursor::new(body);
        Ok(Self {
            factory: c.key()?,
            admin: c.key()?,
            collateral_mint: c.key()?,
            collateral_vault: c.key()?,
            oracle_adapter: c.key()?,
            p_mint: c.key()?,
            n_mint: c.key()?,
            strike: c.i128()?,
            price_decimals: c.u32()?,
            collateral_decimals: c.u8()?,
            multiplier_at_creation: c.i128()?,
            maturity_ts: c.i64()?,
            settlement_delay_secs: c.i64()?,
            max_oracle_age_secs: c.i64()?,
            max_price_lag_secs: c.i64()?,
            min_split_amount: c.u64()?,
            fee_bps: c.u16()?,
            fee_recipient: c.key()?,
            status: SeriesStatus::from_tag(c.u8()?)?,
            bump: c.u8()?,
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), OptionsError> {
        if data.len() < SERIES_CONFIG_LEN {
            return Err(OptionsError::InvalidParams);
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&SERIES_CONFIG_DISC);
        let mut w = Writer::new(&mut data[DISCRIMINATOR_LEN..]);
        for k in [
            &self.factory,
            &self.admin,
            &self.collateral_mint,
            &self.collateral_vault,
            &self.oracle_adapter,
            &self.p_mint,
            &self.n_mint,
        ] {
            w.put(k)?;
        }
        w.put(&self.strike.to_le_bytes())?;
        w.put(&self.price_decimals.to_le_bytes())?;
        w.put(&[self.collateral_decimals])?;
        w.put(&self.multiplier_at_creation.to_le_bytes())?;
        w.put(&self.maturity_ts.to_le_bytes())?;
        w.put(&self.settlement_delay_secs.to_le_bytes())?;
        w.put(&self.max_oracle_age_secs.to_le_bytes())?;
        w.put(&self.max_price_lag_secs.to_le_bytes())?;
        w.put(&self.min_split_amount.to_le_bytes())?;
        w.put(&self.fee_bps.to_le_bytes())?;
        w.put(&self.fee_recipient)?;
        w.put(&[self.status.tag()])?;
        w.put(&[self.bump])?;
        Ok(())
    }
}

/// The frozen result of settlement, written once; only its counters move.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub series: [u8; 32],
    pub price: i128,
    pub price_decimals: u32,
    pub price_ts: i64,
    pub settled_ts: i64,
    pub collateral_at_settlement: u64,
    pub p_supply_at_settlement: u64,
    pub n_supply_at_settlement: u64,
    pub p_pool: u64,
    pub n_pool: u64,
    pub p_redeemed: u64,
    pub n_redeemed: u64,
    pub p_paid: u64,
    pub n_paid: u64,
    pub multiplier_at_settlement: i128,
    pub effective_strike: i128,
    pub shortfall_observed: bool,
    pub supply_mismatch: bool,
    pub bump: u8,
}

impl Settlement {
    pub fn load(data: &[u8]) -> Result<Self, OptionsError> {
        let body = strip(data, &SETTLEMENT_DISC, SETTLEMENT_LEN)?;
        let mut c = Cursor::new(body);
        Ok(Self {
            series: c.key()?,
            price: c.i128()?,
            price_decimals: c.u32()?,
            price_ts: c.i64()?,
            settled_ts: c.i64()?,
            collateral_at_settlement: c.u64()?,
            p_supply_at_settlement: c.u64()?,
            n_supply_at_settlement: c.u64()?,
            p_pool: c.u64()?,
            n_pool: c.u64()?,
            p_redeemed: c.u64()?,
            n_redeemed: c.u64()?,
            p_paid: c.u64()?,
            n_paid: c.u64()?,
            multiplier_at_settlement: c.i128()?,
            effective_strike: c.i128()?,
            shortfall_observed: c.bool()?,
            supply_mismatch: c.bool()?,
            bump: c.u8()?,
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), OptionsError> {
        if data.len() < SETTLEMENT_LEN {
            return Err(OptionsError::InvalidParams);
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&SETTLEMENT_DISC);
        let mut w = Writer::new(&mut data[DISCRIMINATOR_LEN..]);
        w.put(&self.series)?;
        w.put(&self.price.to_le_bytes())?;
        w.put(&self.price_decimals.to_le_bytes())?;
        w.put(&self.price_ts.to_le_bytes())?;
        w.put(&self.settled_ts.to_le_bytes())?;
        for v in [
            self.collateral_at_settlement,
            self.p_supply_at_settlement,
            self.n_supply_at_settlement,
            self.p_pool,
            self.n_pool,
            self.p_redeemed,
            self.n_redeemed,
            self.p_paid,
            self.n_paid,
        ] {
            w.put(&v.to_le_bytes())?;
        }
        w.put(&self.multiplier_at_settlement.to_le_bytes())?;
        w.put(&self.effective_strike.to_le_bytes())?;
        w.put(&[self.shortfall_observed as u8])?;
        w.put(&[self.supply_mismatch as u8])?;
        w.put(&[self.bump])?;
        Ok(())
    }
}
