// SPDX-License-Identifier: Apache-2.0
//! Differential conformance: the Anchor build and the Pinocchio build must be
//! indistinguishable to a client.
//!
//! Both crates are linked here and run against the *same* bytes. Shared golden
//! vectors prove each decoder is individually right; this file proves they are
//! right *together*, including on inputs nobody wrote a fixture for.
//!
//! Two decoders written from the same spec by different means — one deriving
//! borsh, one walking a cursor — is exactly the setup where a differential test
//! earns its keep. Any place they disagree, one of them is wrong about the wire
//! format, and a fixture-only suite would never say which.

use {
    oracle_adapter::pyth::PriceUpdateV2 as AnchorUpdate,
    oracle_adapter_pinocchio::{
        pyth::{PriceUpdateV2 as PinUpdate, PYTH_RECEIVER_ID},
        quote::scale_from_expo as pin_scale,
        state::{FEED_CONFIG_DISCRIMINATOR, FEED_CONFIG_LEN},
    },
    proptest::prelude::*,
};

const DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// A valid `Full` update, built field by field so tests can perturb it.
fn full_update() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&DISC);
    v.extend_from_slice(&[7u8; 32]); // write_authority
    v.push(1); // VerificationLevel::Full
    v.extend_from_slice(&[9u8; 32]); // feed_id
    v.extend_from_slice(&400_00000000i64.to_le_bytes());
    v.extend_from_slice(&12_345u64.to_le_bytes());
    v.extend_from_slice(&(-8i32).to_le_bytes());
    v.extend_from_slice(&1_760_000_000i64.to_le_bytes());
    v.extend_from_slice(&1_759_999_900i64.to_le_bytes());
    v.extend_from_slice(&399_00000000i64.to_le_bytes());
    v.extend_from_slice(&999u64.to_le_bytes());
    v.extend_from_slice(&42u64.to_le_bytes());
    v
}

/// Compare the two decoders on one input. Returns whether both accepted, so a
/// caller can assert coverage rather than vacuously passing on all-rejects.
fn agree(data: &[u8]) -> bool {
    let a = AnchorUpdate::try_from_account_data(data);
    let p = PinUpdate::try_from_account_data(data);

    match (a, p) {
        (Ok(a), Ok(p)) => {
            assert_eq!(a.write_authority.to_bytes(), p.write_authority);
            assert_eq!(a.posted_slot, p.posted_slot);
            assert_eq!(a.price_message.feed_id, p.price_message.feed_id);
            assert_eq!(a.price_message.price, p.price_message.price);
            assert_eq!(a.price_message.conf, p.price_message.conf);
            assert_eq!(a.price_message.exponent, p.price_message.exponent);
            assert_eq!(a.price_message.publish_time, p.price_message.publish_time);
            assert_eq!(
                a.price_message.prev_publish_time,
                p.price_message.prev_publish_time
            );
            assert_eq!(a.price_message.ema_price, p.price_message.ema_price);
            assert_eq!(a.price_message.ema_conf, p.price_message.ema_conf);
            // The verification level drives the signature floor, so agreement
            // on the payload is not enough -- they must classify it the same.
            assert_eq!(
                a.verification_level.meets(0),
                p.verification_level.meets(0)
            );
            for floor in [0u8, 1, 5, 13, 255] {
                assert_eq!(
                    a.verification_level.meets(floor),
                    p.verification_level.meets(floor),
                    "floor {floor}"
                );
            }
            true
        }
        (Err(_), Err(_)) => false,
        (a, p) => panic!(
            "decoders disagree on acceptance: anchor={:?} pinocchio={:?}\ndata={:?}",
            a.is_ok(),
            p.is_ok(),
            data
        ),
    }
}

#[test]
fn the_receiver_id_matches_its_base58() {
    let decoded = bs58::decode("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ")
        .into_vec()
        .expect("valid base58");
    assert_eq!(decoded.as_slice(), &PYTH_RECEIVER_ID);
    // And the Anchor build resolved the same string to the same key.
    assert_eq!(
        oracle_adapter::pyth::PYTH_RECEIVER_ID.to_bytes(),
        PYTH_RECEIVER_ID
    );
}

#[test]
fn the_feed_config_layout_matches_anchor() {
    use anchor_lang::Space;
    // Anchor sizes the account as 8 (discriminator) + InitSpace.
    assert_eq!(FEED_CONFIG_LEN, 8 + oracle_adapter::FeedConfig::INIT_SPACE);
    // And the discriminator is the one Anchor derives.
    assert_eq!(
        anchor_lang::solana_program::hash::hash(b"account:FeedConfig").to_bytes()[..8],
        FEED_CONFIG_DISCRIMINATOR
    );
}

#[test]
fn both_decoders_accept_a_valid_full_update() {
    assert!(agree(&full_update()), "the fixture must actually decode");
}

#[test]
fn both_decoders_accept_a_valid_partial_update() {
    let mut v = full_update();
    // Swap the Full tag for Partial{5}, shifting everything after it.
    v.splice(40..41, [0u8, 5]);
    assert!(agree(&v));
}

/// The receiver over-allocates, so trailing bytes are normal in production.
#[test]
fn both_tolerate_trailing_bytes_identically() {
    for pad in 1..=32usize {
        let mut v = full_update();
        v.extend(core::iter::repeat(0u8).take(pad));
        assert!(agree(&v), "pad {pad}");
    }
}

/// Every truncation must be rejected by both, and neither may panic.
#[test]
fn both_reject_every_truncation() {
    let v = full_update();
    for len in 0..v.len() {
        assert!(!agree(&v[..len]), "a {len}-byte prefix decoded");
    }
}

/// The verification tag is the one variable-width field, and the field that
/// decides how much of the rest is trusted. Walk every possible tag byte.
#[test]
fn both_agree_on_every_verification_tag_byte() {
    let mut accepted = 0;
    for tag in 0..=u8::MAX {
        let mut v = full_update();
        v[40] = tag;
        if agree(&v) {
            accepted += 1;
        }
    }
    // Only Full (1) can decode at this length; Partial (0) consumes an extra
    // byte and runs off the end of a Full-sized buffer.
    assert_eq!(accepted, 1, "exactly one tag should decode at this length");
}

/// Corrupting any single byte of the discriminator must be rejected by both.
#[test]
fn both_reject_every_single_bit_flip_in_the_discriminator() {
    for byte in 0..8usize {
        for bit in 0..8 {
            let mut v = full_update();
            v[byte] ^= 1 << bit;
            assert!(!agree(&v), "byte {byte} bit {bit} decoded");
        }
    }
}

proptest! {
    /// Arbitrary bytes: neither decoder may panic, and they must always reach
    /// the same verdict. This is the case fixtures cannot cover.
    #[test]
    fn arbitrary_bytes_never_disagree(data in prop::collection::vec(any::<u8>(), 0..300)) {
        let _ = agree(&data);
    }

    /// Arbitrary bytes behind a *valid* discriminator — the interesting region,
    /// since a random buffer almost never gets past the first eight bytes.
    #[test]
    fn arbitrary_payloads_never_disagree(tail in prop::collection::vec(any::<u8>(), 0..200)) {
        let mut data = DISC.to_vec();
        data.extend_from_slice(&tail);
        let _ = agree(&data);
    }

    /// A well-formed update with every field randomised. Both decoders must
    /// accept and agree on all of it.
    #[test]
    fn well_formed_updates_always_agree(
        authority in any::<[u8; 32]>(),
        feed_id in any::<[u8; 32]>(),
        price in any::<i64>(),
        conf in any::<u64>(),
        exponent in any::<i32>(),
        publish_time in any::<i64>(),
        prev_publish_time in any::<i64>(),
        ema_price in any::<i64>(),
        ema_conf in any::<u64>(),
        posted_slot in any::<u64>(),
        partial in any::<Option<u8>>(),
    ) {
        let mut v = Vec::new();
        v.extend_from_slice(&DISC);
        v.extend_from_slice(&authority);
        match partial {
            Some(sigs) => { v.push(0); v.push(sigs); }
            None => v.push(1),
        }
        v.extend_from_slice(&feed_id);
        v.extend_from_slice(&price.to_le_bytes());
        v.extend_from_slice(&conf.to_le_bytes());
        v.extend_from_slice(&exponent.to_le_bytes());
        v.extend_from_slice(&publish_time.to_le_bytes());
        v.extend_from_slice(&prev_publish_time.to_le_bytes());
        v.extend_from_slice(&ema_price.to_le_bytes());
        v.extend_from_slice(&ema_conf.to_le_bytes());
        v.extend_from_slice(&posted_slot.to_le_bytes());
        prop_assert!(agree(&v));
    }

    /// The scaling both variants apply to a Pyth exponent must be identical,
    /// including which inputs are refused.
    #[test]
    fn scale_from_expo_agrees(price in any::<i64>(), expo in -40i32..40) {
        let a = oracle_adapter::scale_from_expo(price, expo).ok();
        let p = pin_scale(price, expo).ok();
        prop_assert_eq!(a, p, "price {} expo {}", price, expo);
    }
}

/// Exhaustive rather than sampled, for the exponent domain that actually
/// matters — every Pyth feed in production reports somewhere in here.
#[test]
fn scale_from_expo_agrees_across_the_whole_realistic_domain() {
    let prices = [
        i64::MIN,
        -1,
        0,
        1,
        7,
        400_00000000,
        i64::MAX,
        i64::MAX / 10,
    ];
    for expo in -25i32..=25 {
        for price in prices {
            let a = oracle_adapter::scale_from_expo(price, expo).ok();
            let p = pin_scale(price, expo).ok();
            assert_eq!(a, p, "price {price} expo {expo}");
        }
    }
}
