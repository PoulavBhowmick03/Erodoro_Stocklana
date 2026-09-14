// SPDX-License-Identifier: Apache-2.0
//!
//! Every event, byte-equal to Anchor's `Event::data`: the 8-byte
//! `sha256("event:<Name>")` discriminator plus the borsh body. A listener
//! built against the Anchor IDL reads `Program data:` lines, so this is what
//! keeps it working against the port.

use {
    anchor_lang::Event,
    series::{AdminRenounced, DustSwept, MergeExecuted, Redeemed, SeriesCreated, SeriesSettled,
        ShortfallObserved, SplitExecuted, SplitsPaused},
    series_pinocchio::events as ev,
    solana_pubkey::Pubkey,
};

fn key(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn anchor_pubkey(bytes: &[u8; 32]) -> Pubkey {
    Pubkey::new_from_array(*bytes)
}

#[test]
fn event_discriminators_are_the_anchor_derivations() {
    use sha2::{Digest, Sha256};
    let cases = [
        ("SeriesCreated", ev::SERIES_CREATED_DISC),
        ("SplitExecuted", ev::SPLIT_EXECUTED_DISC),
        ("MergeExecuted", ev::MERGE_EXECUTED_DISC),
        ("SeriesSettled", ev::SERIES_SETTLED_DISC),
        ("Redeemed", ev::REDEEMED_DISC),
        ("ShortfallObserved", ev::SHORTFALL_OBSERVED_DISC),
        ("SplitsPaused", ev::SPLITS_PAUSED_DISC),
        ("AdminRenounced", ev::ADMIN_RENOUNCED_DISC),
        ("DustSwept", ev::DUST_SWEPT_DISC),
    ];
    for (name, discriminator) in cases {
        let mut hasher = Sha256::new();
        hasher.update(format!("event:{name}").as_bytes());
        let digest = hasher.finalize();
        assert_eq!(
            &digest[..8],
            &discriminator,
            "discriminator for {name} drifted"
        );
    }
}

#[test]
fn series_created_matches_anchor() {
    let anchor = SeriesCreated {
        series: anchor_pubkey(&key(1)),
        collateral_mint: anchor_pubkey(&key(2)),
        p_mint: anchor_pubkey(&key(3)),
        n_mint: anchor_pubkey(&key(4)),
        strike: -500,
        price_decimals: 8,
        maturity_ts: 1_760_000_000,
        multiplier_at_creation: 1_000_000_000_000,
    };
    assert_eq!(
        ev::series_created_data(&key(1), &key(2), &key(3), &key(4), -500, 8, 1_760_000_000, 1_000_000_000_000).as_slice(),
        anchor.data().as_slice(),
    );
}

#[test]
fn split_and_merge_match_anchor() {
    let split = SplitExecuted {
        series: anchor_pubkey(&key(1)),
        holder: anchor_pubkey(&key(2)),
        deposited: u64::MAX,
        minted: 999,
        fee: 1,
    };
    assert_eq!(
        ev::split_executed_data(&key(1), &key(2), u64::MAX, 999, 1).as_slice(),
        split.data().as_slice(),
    );

    let merge = MergeExecuted {
        series: anchor_pubkey(&key(1)),
        holder: anchor_pubkey(&key(2)),
        amount: 7,
    };
    assert_eq!(
        ev::merge_executed_data(&key(1), &key(2), 7).as_slice(),
        merge.data().as_slice(),
    );
}

#[test]
fn series_settled_matches_anchor() {
    let anchor = SeriesSettled {
        series: anchor_pubkey(&key(1)),
        price: 600_00000000,
        price_decimals: 8,
        price_ts: 1_760_000_100,
        collateral: 1_000_000,
        p_pool: 500_000,
        n_pool: 500_000,
        effective_strike: 500_00000000,
        multiplier_at_creation: 1_000_000_000_000,
        multiplier_at_settlement: 2_000_000_000_000,
        supply_mismatch: true,
        under_collateralized: false,
    };
    assert_eq!(
        ev::series_settled_data(
            &key(1), 600_00000000, 8, 1_760_000_100, 1_000_000, 500_000, 500_000,
            500_00000000, 1_000_000_000_000, 2_000_000_000_000, true, false,
        )
        .as_slice(),
        anchor.data().as_slice(),
    );
}

#[test]
fn redemption_and_shortfall_match_anchor() {
    let anchor = Redeemed {
        series: anchor_pubkey(&key(1)),
        holder: anchor_pubkey(&key(2)),
        is_p_side: false,
        burned: 11,
        quoted: 22,
        paid: 21,
    };
    assert_eq!(
        ev::redeemed_data(&key(1), &key(2), false, 11, 22, 21).as_slice(),
        anchor.data().as_slice(),
    );

    let anchor = ShortfallObserved {
        series: anchor_pubkey(&key(1)),
        quoted: 100,
        paid: 90,
    };
    assert_eq!(
        ev::shortfall_observed_data(&key(1), 100, 90).as_slice(),
        anchor.data().as_slice(),
    );
}

#[test]
fn admin_lifecycle_matches_anchor() {
    let anchor = SplitsPaused {
        series: anchor_pubkey(&key(1)),
        paused: true,
    };
    assert_eq!(
        ev::splits_paused_data(&key(1), true).as_slice(),
        anchor.data().as_slice(),
    );

    let anchor = AdminRenounced {
        series: anchor_pubkey(&key(1)),
    };
    assert_eq!(
        ev::admin_renounced_data(&key(1)).as_slice(),
        anchor.data().as_slice(),
    );

    let anchor = DustSwept {
        series: anchor_pubkey(&key(1)),
        amount: 3,
    };
    assert_eq!(
        ev::dust_swept_data(&key(1), 3).as_slice(),
        anchor.data().as_slice(),
    );
}
