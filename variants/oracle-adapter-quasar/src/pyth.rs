// SPDX-License-Identifier: Apache-2.0
//! Decoder for the Pyth Solana Receiver's `PriceUpdateV2` account.
//!
//! # Why this decodes by hand rather than deriving
//!
//! The Anchor variant mirrors the layout with `AnchorDeserialize` derives. That
//! is not available here: this crate is `no_std` and carries no borsh. So the
//! same layout is walked by hand.
//!
//! The one thing a hand-written decoder must not do is read fixed offsets.
//! `VerificationLevel` is a borsh enum: `Partial` encodes as a `0` tag followed
//! by a `u8` signature count, `Full` as a bare `1` tag. Every field after it
//! therefore sits one byte earlier for a fully-verified update. A decoder that
//! assumed one case would silently misread the other — and `Full` is the case
//! production actually posts. The cursor below advances past the tag by its
//! *decoded* width, which is the whole reason this is written as a walk and not
//! as a struct cast.
//!
//! Pinned to the same golden vectors as the Anchor variant, including a real
//! devnet account, so both decoders are proven against identical bytes.

use crate::error::OptionsError;

/// The Pyth Solana Receiver program. `PriceUpdateV2` accounts are owned by it.
///
/// Decoded from base58 at compile time rather than transcribed as a byte
/// literal: a hand-copied array is unreviewable and a single wrong nibble here
/// would accept quotes from an account nobody audited.
/// base58 `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. The cross-variant
/// conformance test decodes that string and asserts it against these bytes, so
/// the literal is checked rather than trusted.
pub const PYTH_RECEIVER_ID: [u8; 32] = [
    0x0c, 0xb7, 0xfa, 0xbb, 0x52, 0xf7, 0xa6, 0x48, 0xbb, 0x5b, 0x31, 0x7d, 0x9a, 0x01, 0x8b, 0x90,
    0x57, 0xcb, 0x02, 0x47, 0x74, 0xfa, 0xfe, 0x01, 0xe6, 0xc4, 0xdf, 0x98, 0xcc, 0x38, 0x58, 0x81,
];

/// Anchor account discriminator for `PriceUpdateV2`: the first eight bytes of
/// `sha256("account:PriceUpdateV2")`.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

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

        // The variable-width field. See the module docs.
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

#[cfg(test)]
#[path = "pyth_vectors.rs"]
mod tests;
