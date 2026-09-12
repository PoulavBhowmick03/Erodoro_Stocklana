// SPDX-License-Identifier: Apache-2.0
//! Decoder for the Pyth Solana Receiver's `PriceUpdateV2` account.
//!
//! # Why this is a local mirror rather than the SDK
//!
//! `pyth-solana-receiver-sdk` is not usable here. Its transitive
//! `pythnet-sdk` derives Anchor traits while depending on borsh 1.x, so it
//! only compiles when Cargo hands it anchor-lang 1.x. This workspace pins
//! anchor-lang 0.31.1, and Cargo unifies `pythnet-sdk` onto that same 0.31.1 —
//! whose derives emit `borsh::maybestd` paths that borsh 1.x removed. The
//! result is a build that succeeds or fails depending on the order the
//! lockfile was generated in. That is not a dependency worth having.
//!
//! So the account layout is mirrored here instead, with two properties that
//! make the mirror trustworthy:
//!
//! 1. **It is derived, not offset-based.** `VerificationLevel` is a borsh enum
//!    whose encoding is 1 byte for `Full` and 2 for `Partial`, so the fields
//!    after it sit at different offsets depending on how the update was
//!    verified. Anything reading fixed offsets is wrong for one of the two
//!    cases. The derive handles it.
//! 2. **It is pinned to golden vectors produced by the real SDK.** The tests
//!    at the bottom of this file decode byte-for-byte output from
//!    `pyth-solana-receiver-sdk` 2.0.0 for both verification levels. If
//!    upstream ever changes the layout, those vectors are what catches it.
//!
//! Re-check this against the published SDK before mainnet, alongside the rest
//! of the §15 checklist.

use anchor_lang::prelude::*;
use common::OptionsError;

/// The Pyth Solana Receiver program. `PriceUpdateV2` accounts are owned by it.
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Anchor account discriminator for `PriceUpdateV2`: the first eight bytes of
/// `sha256("account:PriceUpdateV2")`.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// How thoroughly the receiver checked the Wormhole signatures behind an
/// update.
///
/// `Partial` carries the number of guardian signatures that were verified. A
/// low count is cheap to post and correspondingly cheap to forge, which is why
/// [`super::FeedConfig`] carries a floor.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
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

/// The price payload itself. Note what is *not* here: any notion of whether
/// the underlying market was open. See the crate docs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

impl PriceUpdateV2 {
    /// Decode a `PriceUpdateV2` from raw account data, discriminator included.
    pub fn try_from_account_data(data: &[u8]) -> Result<Self> {
        require!(data.len() > 8, OptionsError::OraclePriceInvalid);
        require!(
            data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
            OptionsError::OraclePriceInvalid
        );
        let mut rest = &data[8..];
        Self::deserialize(&mut rest).map_err(|_| error!(OptionsError::OraclePriceInvalid))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-for-byte output of `pyth-solana-receiver-sdk` 2.0.0 serializing a
    /// `PriceUpdateV2` with `VerificationLevel::Partial { num_signatures: 5 }`.
    const GOLDEN_PARTIAL: [u8; 134] = [
        34, 241, 35, 99, 157, 126, 244, 205, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
        7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 0, 5, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
        9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 144, 47, 80, 9, 0, 0, 0, 57, 48,
        0, 0, 0, 0, 0, 0, 248, 255, 255, 255, 0, 120, 231, 104, 0, 0, 0, 0, 156, 119, 231, 104, 0,
        0, 0, 0, 0, 175, 57, 74, 9, 0, 0, 0, 231, 3, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0,
    ];

    /// The same update with `VerificationLevel::Full`. One byte shorter, and
    /// every field after the tag shifts — which is exactly why this decoder
    /// must not read fixed offsets.
    const GOLDEN_FULL: [u8; 133] = [
        34, 241, 35, 99, 157, 126, 244, 205, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
        7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
        9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 144, 47, 80, 9, 0, 0, 0, 57, 48, 0,
        0, 0, 0, 0, 0, 248, 255, 255, 255, 0, 120, 231, 104, 0, 0, 0, 0, 156, 119, 231, 104, 0, 0,
        0, 0, 0, 175, 57, 74, 9, 0, 0, 0, 231, 3, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0,
    ];

    fn expected_message() -> PriceFeedMessage {
        PriceFeedMessage {
            feed_id: [9u8; 32],
            price: 400_00000000,
            conf: 12_345,
            exponent: -8,
            publish_time: 1_760_000_000,
            prev_publish_time: 1_759_999_900,
            ema_price: 399_00000000,
            ema_conf: 999,
        }
    }

    #[test]
    fn decodes_a_partially_verified_update_from_the_sdk() {
        let update = PriceUpdateV2::try_from_account_data(&GOLDEN_PARTIAL).unwrap();
        assert_eq!(update.write_authority, Pubkey::new_from_array([7u8; 32]));
        assert_eq!(
            update.verification_level,
            VerificationLevel::Partial { num_signatures: 5 }
        );
        assert_eq!(update.price_message, expected_message());
        assert_eq!(update.posted_slot, 42);
    }

    #[test]
    fn decodes_a_fully_verified_update_from_the_sdk() {
        let update = PriceUpdateV2::try_from_account_data(&GOLDEN_FULL).unwrap();
        assert_eq!(update.verification_level, VerificationLevel::Full);
        // The payload is identical to the partial case even though every byte
        // after the tag sits one position earlier.
        assert_eq!(update.price_message, expected_message());
        assert_eq!(update.posted_slot, 42);
    }

    #[test]
    fn round_trips_both_verification_levels() {
        for golden in [&GOLDEN_PARTIAL[..], &GOLDEN_FULL[..]] {
            let update = PriceUpdateV2::try_from_account_data(golden).unwrap();
            let mut buf = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
            update.serialize(&mut buf).unwrap();
            assert_eq!(buf, golden, "re-encoding must reproduce the SDK's bytes");
        }
    }

    /// A real `PriceUpdateV2` account, fetched from Solana devnet
    /// (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, the sponsored SOL/USD
    /// feed) on 2026-08-13.
    ///
    /// Two things this catches that synthetic vectors do not. The receiver
    /// **over-allocates**: this is a `Full` update, which serializes to 133
    /// bytes, in a 134-byte account — so the decoder has to tolerate trailing
    /// bytes. And the `write_authority` is the price account itself, which is
    /// not something a hand-built fixture would think to do.
    const LIVE_DEVNET_SOL_USD: [u8; 134] = [
        34, 241, 35, 99, 157, 126, 244, 205, 96, 49, 71, 4, 52, 13, 237, 223, 55, 31, 212, 36, 114,
        20, 143, 36, 142, 157, 26, 109, 26, 94, 178, 172, 58, 205, 139, 127, 213, 214, 178, 67, 1,
        239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142,
        208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109, 52, 230, 145, 197, 1, 0, 0, 0,
        94, 85, 66, 0, 0, 0, 0, 0, 248, 255, 255, 255, 183, 57, 126, 106, 0, 0, 0, 0, 183, 57, 126,
        106, 0, 0, 0, 0, 240, 16, 156, 197, 1, 0, 0, 0, 228, 240, 67, 0, 0, 0, 0, 0, 10, 15, 211,
        28, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn decodes_a_live_pyth_account_from_devnet() {
        let update = PriceUpdateV2::try_from_account_data(&LIVE_DEVNET_SOL_USD).unwrap();

        // The account is one byte longer than a `Full` update needs.
        assert_eq!(LIVE_DEVNET_SOL_USD.len(), 134);
        assert_eq!(update.verification_level, VerificationLevel::Full);

        let msg = update.price_message;
        // The canonical Pyth SOL/USD feed id.
        assert_eq!(
            msg.feed_id,
            [
                0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1,
                0xda, 0x39, 0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8,
                0xc2, 0x80, 0xb5, 0x6d
            ]
        );
        assert_eq!(msg.exponent, -8, "equity and SOL feeds alike report -8");
        assert!(msg.price > 0);
        assert!(msg.conf > 0);
        assert!(
            msg.publish_time > 1_700_000_000,
            "a plausible unix timestamp"
        );
        assert!(msg.prev_publish_time <= msg.publish_time);

        // And it flows through the same scaling the series uses: $76.11 at 8
        // decimals.
        let (price, decimals) = super::super::scale_from_expo(msg.price, msg.exponent).unwrap();
        assert_eq!(decimals, 8);
        assert_eq!(price, msg.price as i128);
        assert!(
            (70..90).contains(&(price / 100_000_000)),
            "SOL/USD in a sane band"
        );
    }

    #[test]
    fn a_full_update_padded_to_the_partial_length_still_decodes() {
        // The general form of what the live account exposed: the receiver
        // allocates for the longest verification level and leaves the tail
        // unused. A decoder that demanded an exact length would reject every
        // fully-verified update in production.
        let mut padded = GOLDEN_FULL.to_vec();
        padded.extend_from_slice(&[0u8; 7]);
        let update = PriceUpdateV2::try_from_account_data(&padded).unwrap();
        assert_eq!(update.verification_level, VerificationLevel::Full);
        assert_eq!(update.price_message, expected_message());
    }

    #[test]
    fn rejects_a_foreign_discriminator() {
        let mut data = GOLDEN_FULL;
        data[0] ^= 0xff;
        assert!(PriceUpdateV2::try_from_account_data(&data).is_err());
    }

    #[test]
    fn rejects_truncated_data() {
        assert!(PriceUpdateV2::try_from_account_data(&[]).is_err());
        assert!(PriceUpdateV2::try_from_account_data(&GOLDEN_FULL[..8]).is_err());
        assert!(PriceUpdateV2::try_from_account_data(&GOLDEN_FULL[..40]).is_err());
    }

    #[test]
    fn verification_floor_admits_full_and_gates_partial() {
        assert!(VerificationLevel::Full.meets(13));
        assert!(VerificationLevel::Partial { num_signatures: 13 }.meets(13));
        assert!(!VerificationLevel::Partial { num_signatures: 12 }.meets(13));
        // A zero floor accepts anything, which is why the config validates it.
        assert!(VerificationLevel::Partial { num_signatures: 0 }.meets(0));
    }

    #[test]
    fn the_discriminator_is_the_anchor_derivation() {
        // sha256("account:PriceUpdateV2")[..8], independent of the golden
        // vectors above — two derivations agreeing on the same eight bytes.
        use anchor_lang::solana_program::hash::hash;
        let derived = hash(b"account:PriceUpdateV2").to_bytes();
        assert_eq!(derived[..8], PRICE_UPDATE_V2_DISCRIMINATOR);
    }
}
