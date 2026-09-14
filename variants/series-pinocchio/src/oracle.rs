// SPDX-License-Identifier: Apache-2.0
//! Reading settlement quotes without the oracle program.
//!
//! `settle` needs one thing from the oracle adapter: a validated quote for the
//! feed a series is pinned to. Rather than linking the whole oracle program,
//! this module carries the two byte-level pieces that read requires — the
//! `PriceUpdateV2` walk and the quote validation — against a borrowed view of
//! the `FeedConfig` account. The decoder is the Pinocchio oracle variant's,
//! unchanged; only the config access is by view instead of by account type.
//!
//! Proven in `tests/oracle_wire.rs` against the Anchor oracle crate over the
//! shared Pyth fixtures: same bytes in, same quote or same error out.

use common::OptionsError;

/// The Pyth Solana Receiver program. `PriceUpdateV2` accounts are owned by it.
///
/// Decoded from base58 at compile time rather than transcribed as a byte
/// literal: a hand-copied array is unreviewable and a single wrong nibble here
/// would accept quotes from an account nobody audited.
pub const PYTH_RECEIVER_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Anchor account discriminator for `PriceUpdateV2`: the first eight bytes of
/// `sha256("account:PriceUpdateV2")`.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// `sha256("account:FeedConfig")[..8]`, the discriminator Anchor writes ahead
/// of every feed config.
pub const FEED_CONFIG_DISCRIMINATOR: [u8; 8] = [75, 97, 12, 15, 89, 221, 78, 71];

/// Total feed-config account size including the discriminator.
pub const FEED_CONFIG_LEN: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1;

/// Matches `common::math::MAX_DECIMALS`.
pub const MAX_DECIMALS: u32 = 18;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

impl VerificationLevel {
    /// Whether this update was verified by at least `min_signatures`
    /// guardians. `Full` clears any floor.
    pub fn meets(&self, min_signatures: u8) -> bool {
        match self {
            VerificationLevel::Full => true,
            VerificationLevel::Partial { num_signatures } => *num_signatures >= min_signatures,
        }
    }
}

/// The price payload. Note what is *not* here: any notion of whether the
/// underlying market was open.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    /// Signed exponent: `-8` means `price` carries 8 decimals.
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PriceUpdateV2 {
    pub write_authority: [u8; 32],
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

/// A bounds-checked forward cursor. Every read advances; a read past the end is
/// an error rather than a panic, because this runs on-chain against bytes the
/// program does not control.
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], OptionsError> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(OptionsError::OraclePriceInvalid)?;
        if end > self.data.len() {
            return Err(OptionsError::OraclePriceInvalid);
        }
        let out = &self.data[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, OptionsError> {
        Ok(self.take(1)?[0])
    }

    fn array32(&mut self) -> Result<[u8; 32], OptionsError> {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.take(32)?);
        Ok(out)
    }

    fn i32(&mut self) -> Result<i32, OptionsError> {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.take(4)?);
        Ok(i32::from_le_bytes(b))
    }

    fn i64(&mut self) -> Result<i64, OptionsError> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(i64::from_le_bytes(b))
    }

    fn u64(&mut self) -> Result<u64, OptionsError> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(b))
    }
}

impl PriceUpdateV2 {
    /// Decode a `PriceUpdateV2` from raw account data, discriminator included.
    ///
    /// Trailing bytes are tolerated on purpose: the receiver allocates for the
    /// longest verification level, so a `Full` update lives in an account one
    /// byte larger than it needs. Demanding an exact length would reject every
    /// fully-verified update in production.
    pub fn try_from_account_data(data: &[u8]) -> Result<Self, OptionsError> {
        if data.len() <= 8 || data[..8] != PRICE_UPDATE_V2_DISCRIMINATOR {
            return Err(OptionsError::OraclePriceInvalid);
        }
        let mut c = Cursor::new(&data[8..]);

        let write_authority = c.array32()?;

        // The variable-width field: `Partial` encodes as a `0` tag followed by
        // a `u8` count, `Full` as a bare `1` tag. Every field after it sits
        // one byte earlier for a fully-verified update.
        let verification_level = match c.u8()? {
            0 => VerificationLevel::Partial {
                num_signatures: c.u8()?,
            },
            1 => VerificationLevel::Full,
            _ => return Err(OptionsError::OraclePriceInvalid),
        };

        let price_message = PriceFeedMessage {
            feed_id: c.array32()?,
            price: c.i64()?,
            conf: c.u64()?,
            exponent: c.i32()?,
            publish_time: c.i64()?,
            prev_publish_time: c.i64()?,
            ema_price: c.i64()?,
            ema_conf: c.u64()?,
        };

        let posted_slot = c.u64()?;

        Ok(Self {
            write_authority,
            verification_level,
            price_message,
            posted_slot,
        })
    }
}

/// A normalized, validated quote.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub feed_id: [u8; 32],
    pub price: i128,
    pub decimals: u32,
    /// Publish time reported by the source, not the slot the read happened in.
    pub timestamp: i64,
}

/// `10^exp`, refusing anything past `MAX_DECIMALS`.
pub fn pow10(exp: u32) -> Result<i128, OptionsError> {
    if exp > MAX_DECIMALS {
        return Err(OptionsError::InvalidDecimals);
    }
    let mut acc: i128 = 1;
    for _ in 0..exp {
        acc = acc.checked_mul(10).ok_or(OptionsError::MathOverflow)?;
    }
    Ok(acc)
}

/// Turn a Pyth-style signed exponent into the unsigned decimal count the shared
/// math works in.
///
/// A negative exponent is the normal case and maps straight across: `-8` means
/// the integer carries 8 decimals. A non-negative exponent means the integer is
/// *coarser* than one unit, so it is materialized at 0 decimals rather than
/// pretending to a precision it does not have.
pub fn scale_from_expo(price: i64, expo: i32) -> Result<(i128, u32), OptionsError> {
    let price = price as i128;
    if expo <= 0 {
        let decimals = expo.unsigned_abs();
        if decimals > MAX_DECIMALS {
            return Err(OptionsError::OracleDecimalsInvalid);
        }
        Ok((price, decimals))
    } else {
        let exp = expo as u32;
        if exp > MAX_DECIMALS {
            return Err(OptionsError::OracleDecimalsInvalid);
        }
        let factor = pow10(exp)?;
        let scaled = price
            .checked_mul(factor)
            .ok_or(OptionsError::MathOverflow)?;
        Ok((scaled, 0))
    }
}

/// Decode a Pyth account's bytes into a quote, enforcing the signature floor.
///
/// `owner` is the account's owner program, passed separately so this stays
/// callable without an `AccountView`.
pub fn decode_pyth(
    owner: &[u8; 32],
    data: &[u8],
    min_signatures: u8,
) -> Result<PriceData, OptionsError> {
    if owner != &PYTH_RECEIVER_ID {
        return Err(OptionsError::InvalidOracle);
    }
    let update = PriceUpdateV2::try_from_account_data(data)?;
    if !update.verification_level.meets(min_signatures) {
        return Err(OptionsError::OraclePriceInvalid);
    }
    let msg = update.price_message;
    let (price, decimals) = scale_from_expo(msg.price, msg.exponent)?;
    Ok(PriceData {
        feed_id: msg.feed_id,
        price,
        decimals,
        timestamp: msg.publish_time,
    })
}

/// The feed-config fields `settle` reads, borrowed from the account bytes.
#[derive(Clone, Copy, Debug)]
pub struct FeedConfigView<'a> {
    pub feed_id: &'a [u8; 32],
    pub source: &'a [u8; 32],
    pub max_age_secs: i64,
    pub min_verification_signatures: u8,
}

/// Anchor framework codes this path surfaces, in the order Anchor checks
/// them: owner, then discriminator presence, then discriminator value, then
/// the body. Each is asserted against `anchor_lang::error::ErrorCode` in
/// `tests/oracle_wire.rs`, so a renumber upstream fails loudly.
pub mod framework_code {
    /// The oracle config is not owned by the oracle program.
    pub const OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    /// Fewer than 8 bytes: no discriminator to read.
    pub const DISCRIMINATOR_NOT_FOUND: u32 = 3001;
    /// The discriminator is not this account's.
    pub const DISCRIMINATOR_MISMATCH: u32 = 3002;
    /// Right discriminator, too short a body to hold the config.
    pub const DID_NOT_DESERIALIZE: u32 = 3003;
}

use pinocchio::error::ProgramError;

/// The oracle adapter program id. Decoded from base58 at compile time.
/// Tested against `oracle_adapter::ID`.
pub const ORACLE_ADAPTER_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");

/// Read the config fields out of a feed-config account, failing with the same
/// codes Anchor's account validation would surface: owner, then
/// discriminator, then body.
pub fn read_feed_config<'a>(
    owner: &[u8; 32],
    data: &'a [u8],
) -> Result<FeedConfigView<'a>, ProgramError> {
    use crate::error::err;
    use common::OptionsError;
    if owner != &ORACLE_ADAPTER_PROGRAM_ID {
        return Err(ProgramError::Custom(framework_code::OWNED_BY_WRONG_PROGRAM));
    }
    if data.len() < 8 {
        return Err(ProgramError::Custom(
            framework_code::DISCRIMINATOR_NOT_FOUND,
        ));
    }
    if data[..8] != FEED_CONFIG_DISCRIMINATOR {
        return Err(ProgramError::Custom(framework_code::DISCRIMINATOR_MISMATCH));
    }
    if data.len() < FEED_CONFIG_LEN {
        return Err(ProgramError::Custom(framework_code::DID_NOT_DESERIALIZE));
    }
    let feed_id: &[u8; 32] = data[40..72]
        .try_into()
        .map_err(|_| err(OptionsError::InvalidOracle))?;
    let source: &[u8; 32] = data[72..104]
        .try_into()
        .map_err(|_| err(OptionsError::InvalidOracle))?;
    Ok(FeedConfigView {
        feed_id,
        source,
        max_age_secs: i64::from_le_bytes(data[104..112].try_into().unwrap()),
        min_verification_signatures: data[112],
    })
}

/// Decode and validate the quote behind `cfg`.
///
/// Checks, in order: the account is the one the config names; it is owned by
/// the Pyth receiver; its feed id matches; the price is positive; the publish
/// time is not in the future; and the quote is no older than `max_age_secs`.
///
/// The order matters and is the same as the Anchor variant's, because the error
/// a caller sees is part of the interface.
pub fn read_quote(
    cfg: &FeedConfigView,
    source_key: &[u8; 32],
    source_owner: &[u8; 32],
    source_data: &[u8],
    now: i64,
) -> Result<PriceData, OptionsError> {
    if source_key != cfg.source {
        return Err(OptionsError::FeedMismatch);
    }

    let quote = decode_pyth(source_owner, source_data, cfg.min_verification_signatures)?;

    if quote.feed_id != *cfg.feed_id {
        return Err(OptionsError::FeedMismatch);
    }
    if quote.price <= 0 {
        return Err(OptionsError::OraclePriceInvalid);
    }
    if quote.timestamp > now {
        return Err(OptionsError::OraclePriceInvalid);
    }
    if now.saturating_sub(quote.timestamp) > cfg.max_age_secs {
        return Err(OptionsError::OraclePriceStale);
    }
    Ok(quote)
}

/// The settlement read: a validated quote whose publish time is at or after
/// `after_ts` (the series' maturity) and no older than `max_age_secs`.
///
/// The caller passes its own `max_age_secs`, so a long-dated series and a
/// weekly one can share a feed config without sharing a staleness tolerance.
pub fn read_quote_at_or_after(
    cfg: &FeedConfigView,
    source_key: &[u8; 32],
    source_owner: &[u8; 32],
    source_data: &[u8],
    now: i64,
    after_ts: i64,
    max_age_secs: i64,
) -> Result<PriceData, OptionsError> {
    let quote = read_quote(cfg, source_key, source_owner, source_data, now)?;
    if quote.timestamp < after_ts {
        return Err(OptionsError::OraclePriceStale);
    }
    if now.saturating_sub(quote.timestamp) > max_age_secs {
        return Err(OptionsError::OraclePriceStale);
    }
    Ok(quote)
}
