// SPDX-License-Identifier: Apache-2.0
//! Golden `PriceUpdateV2` vectors, shared byte-for-byte with the Anchor
//! variant's `programs/oracle-adapter/src/pyth.rs`.
//!
//! The point of duplicating them here is conformance: two independently
//! written decoders — one deriving borsh, one walking a cursor by hand — must
//! agree on the same bytes. If they ever diverge, one of them is wrong about
//! the wire format, and these vectors are what says so.

use super::*;

/// Byte-for-byte output of `pyth-solana-receiver-sdk` 2.0.0 serializing a
/// `PriceUpdateV2` with `VerificationLevel::Partial { num_signatures: 5 }`.
const GOLDEN_PARTIAL: [u8; 134] = [
    34, 241, 35, 99, 157, 126, 244, 205, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 0, 5, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 144, 47, 80, 9, 0, 0, 0, 57, 48, 0, 0, 0, 0, 0, 0,
    248, 255, 255, 255, 0, 120, 231, 104, 0, 0, 0, 0, 156, 119, 231, 104, 0, 0, 0, 0, 0, 175, 57,
    74, 9, 0, 0, 0, 231, 3, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0,
];

/// The same update with `VerificationLevel::Full`. One byte shorter, and every
/// field after the tag shifts — which is exactly why the decoder must not read
/// fixed offsets.
const GOLDEN_FULL: [u8; 133] = [
    34, 241, 35, 99, 157, 126, 244, 205, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 144, 47, 80, 9, 0, 0, 0, 57, 48, 0, 0, 0, 0, 0, 0,
    248, 255, 255, 255, 0, 120, 231, 104, 0, 0, 0, 0, 156, 119, 231, 104, 0, 0, 0, 0, 0, 175, 57,
    74, 9, 0, 0, 0, 231, 3, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0,
];

/// A real `PriceUpdateV2` account, fetched from Solana devnet
/// (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, the sponsored SOL/USD
/// feed) on 2026-08-13. `Full` update, 133 bytes of payload, in a 134-byte
/// account — the decoder must tolerate the trailing byte.
const LIVE_DEVNET_SOL_USD: [u8; 134] = [
    34, 241, 35, 99, 157, 126, 244, 205, 96, 49, 71, 4, 52, 13, 237, 223, 55, 31, 212, 36, 114, 20,
    143, 36, 142, 157, 26, 109, 26, 94, 178, 172, 58, 205, 139, 127, 213, 214, 178, 67, 1, 239, 13,
    139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142, 208, 198, 199,
    188, 15, 76, 250, 200, 194, 128, 181, 109, 52, 230, 145, 197, 1, 0, 0, 0, 94, 85, 66, 0, 0, 0,
    0, 0, 248, 255, 255, 255, 183, 57, 126, 106, 0, 0, 0, 0, 183, 57, 126, 106, 0, 0, 0, 0, 240, 16,
    156, 197, 1, 0, 0, 0, 228, 240, 67, 0, 0, 0, 0, 0, 10, 15, 211, 28, 0, 0, 0, 0, 0,
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
fn decodes_a_partially_verified_update() {
    let update = PriceUpdateV2::try_from_account_data(&GOLDEN_PARTIAL).unwrap();
    assert_eq!(update.write_authority, [7u8; 32]);
    assert_eq!(
        update.verification_level,
        VerificationLevel::Partial { num_signatures: 5 }
    );
    assert_eq!(update.price_message, expected_message());
    assert_eq!(update.posted_slot, 42);
}

#[test]
fn decodes_a_fully_verified_update() {
    let update = PriceUpdateV2::try_from_account_data(&GOLDEN_FULL).unwrap();
    assert_eq!(update.verification_level, VerificationLevel::Full);
    // Identical payload even though every byte after the tag sits one position
    // earlier. This is the assertion that a fixed-offset decoder fails.
    assert_eq!(update.price_message, expected_message());
    assert_eq!(update.posted_slot, 42);
}

#[test]
fn decodes_a_live_pyth_account_from_devnet() {
    let update = PriceUpdateV2::try_from_account_data(&LIVE_DEVNET_SOL_USD).unwrap();
    assert_eq!(LIVE_DEVNET_SOL_USD.len(), 134);
    assert_eq!(update.verification_level, VerificationLevel::Full);

    let msg = update.price_message;
    assert_eq!(
        msg.feed_id,
        [
            0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1,
            0xda, 0x39, 0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8,
            0xc2, 0x80, 0xb5, 0x6d
        ],
        "the canonical Pyth SOL/USD feed id"
    );
    assert_eq!(msg.exponent, -8);
    assert!(msg.price > 0);
    assert!(msg.conf > 0);
    assert!(msg.publish_time > 1_700_000_000);
    assert!(msg.prev_publish_time <= msg.publish_time);

    let (price, decimals) = crate::quote::scale_from_expo(msg.price, msg.exponent).unwrap();
    assert_eq!(decimals, 8);
    assert_eq!(price, msg.price as i128);
    assert!((70..90).contains(&(price / 100_000_000)), "SOL/USD in a sane band");
}

#[test]
fn a_full_update_padded_to_the_partial_length_still_decodes() {
    // The receiver allocates for the longest verification level and leaves the
    // tail unused. A decoder demanding an exact length would reject every
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

/// Every prefix of a valid account must either decode or error — never panic.
/// The cursor is the only thing standing between adversarial account bytes and
/// an out-of-bounds read, so it is worth asserting exhaustively rather than at
/// three hand-picked lengths.
#[test]
fn no_prefix_of_a_valid_account_can_panic() {
    for len in 0..=GOLDEN_PARTIAL.len() {
        let _ = PriceUpdateV2::try_from_account_data(&GOLDEN_PARTIAL[..len]);
    }
    for len in 0..=LIVE_DEVNET_SOL_USD.len() {
        let _ = PriceUpdateV2::try_from_account_data(&LIVE_DEVNET_SOL_USD[..len]);
    }
}

/// A truncated-but-past-the-discriminator account must be rejected, not
/// silently decoded from whatever follows.
#[test]
fn every_truncation_after_the_discriminator_is_rejected() {
    for len in 9..GOLDEN_FULL.len() {
        assert!(
            PriceUpdateV2::try_from_account_data(&GOLDEN_FULL[..len]).is_err(),
            "a {len}-byte account decoded when it should not have"
        );
    }
}

#[test]
fn rejects_an_unknown_verification_tag() {
    let mut data = GOLDEN_FULL;
    data[40] = 2; // neither Partial (0) nor Full (1)
    assert!(PriceUpdateV2::try_from_account_data(&data).is_err());
}

#[test]
fn verification_floor_admits_full_and_gates_partial() {
    assert!(VerificationLevel::Full.meets(13));
    assert!(VerificationLevel::Partial { num_signatures: 13 }.meets(13));
    assert!(!VerificationLevel::Partial { num_signatures: 12 }.meets(13));
    // A zero floor accepts anything, which is why the config validates it.
    assert!(VerificationLevel::Partial { num_signatures: 0 }.meets(0));
}

/// The floor must be monotone: if an update clears `n`, it clears everything
/// below `n`. Cheap to assert exhaustively over the whole `u8` domain.
#[test]
fn the_verification_floor_is_monotone() {
    for sigs in 0..=u8::MAX {
        let level = VerificationLevel::Partial {
            num_signatures: sigs,
        };
        for floor in 0..=u8::MAX {
            assert_eq!(level.meets(floor), sigs >= floor);
        }
        assert!(VerificationLevel::Full.meets(sigs));
    }
}
