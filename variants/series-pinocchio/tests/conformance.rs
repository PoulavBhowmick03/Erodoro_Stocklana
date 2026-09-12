// SPDX-License-Identifier: Apache-2.0
//! The two builds of `series`, compared against each other.
//!
//! This links **both crates** and checks that an account written by the port
//! deserialises under Anchor with every field intact, that the discriminators
//! and lengths are the ones Anchor derives, and that the seeds match.
//!
//! # What is deliberately *not* here
//!
//! A differential test of the settlement arithmetic. There is nothing to
//! compare: the port links `common::math` rather than reimplementing it, so
//! `compute_pools`, `compute_redeem`, `apply_shortfall` and `effective_strike`
//! are the same code the Anchor build calls. That is the point — reimplementing
//! this arithmetic and then fuzzing the two against each other would prove they
//! agree while risking the failure fuzzing is weakest against, both sides wrong
//! in the same way because one was written by reading the other.
//!
//! `common`'s own suite covers that math, including proptests, and this file
//! asserts the linkage is real rather than assumed.

use {
    anchor_lang::{prelude::*, Discriminator, Space},
    proptest::prelude::*,
    series_pinocchio::state::{
        self as pin, SeriesConfig as PinConfig, Settlement as PinSettlement,
    },
    sha2::{Digest, Sha256},
};

fn disc(preimage: &str) -> [u8; 8] {
    let h = Sha256::digest(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

// --- Identity and layout --------------------------------------------------

#[test]
fn program_id_matches_the_anchor_variant() {
    assert_eq!(series_pinocchio::ID, series::ID.to_bytes());
}

#[test]
fn account_discriminators_match_anchor() {
    assert_eq!(
        pin::SERIES_CONFIG_DISC,
        series::state::SeriesConfig::DISCRIMINATOR
    );
    assert_eq!(
        pin::SETTLEMENT_DISC,
        series::state::Settlement::DISCRIMINATOR
    );
    // ...and are the derivation, not a lucky pair of literals.
    assert_eq!(pin::SERIES_CONFIG_DISC, disc("account:SeriesConfig"));
    assert_eq!(pin::SETTLEMENT_DISC, disc("account:Settlement"));
}

#[test]
fn account_lengths_match_anchor() {
    assert_eq!(
        pin::SERIES_CONFIG_LEN,
        8 + series::state::SeriesConfig::INIT_SPACE
    );
    assert_eq!(
        pin::SETTLEMENT_LEN,
        8 + series::state::Settlement::INIT_SPACE
    );
}

#[test]
fn seeds_match_the_anchor_variant() {
    assert_eq!(pin::SERIES_SEED, series::SERIES_SEED);
    assert_eq!(pin::P_MINT_SEED, series::P_MINT_SEED);
    assert_eq!(pin::N_MINT_SEED, series::N_MINT_SEED);
    assert_eq!(pin::SETTLEMENT_SEED, series::SETTLEMENT_SEED);
}

/// The status tag is a borsh enum discriminant, so it is declaration order —
/// and the port spells it out. Compared against what Anchor actually writes.
#[test]
fn the_status_tags_match_anchor() {
    use anchor_lang::AnchorSerialize;
    let cases = [
        (pin::SeriesStatus::Open, common::SeriesStatus::Open),
        (pin::SeriesStatus::Paused, common::SeriesStatus::Paused),
        (pin::SeriesStatus::Settled, common::SeriesStatus::Settled),
    ];
    for (mine, theirs) in cases {
        let mut buf = Vec::new();
        theirs.serialize(&mut buf).unwrap();
        assert_eq!(buf, vec![mine.tag()], "{mine:?}");
    }
}

// --- Round trips ----------------------------------------------------------

fn sample_config() -> PinConfig {
    PinConfig {
        factory: [1u8; 32],
        admin: [2u8; 32],
        collateral_mint: [3u8; 32],
        collateral_vault: [4u8; 32],
        oracle_adapter: [5u8; 32],
        p_mint: [6u8; 32],
        n_mint: [7u8; 32],
        strike: i128::MIN + 9,
        price_decimals: 14,
        collateral_decimals: 8,
        multiplier_at_creation: i128::MAX - 3,
        maturity_ts: i64::MIN + 1,
        settlement_delay_secs: -7,
        max_oracle_age_secs: i64::MAX,
        max_price_lag_secs: 0,
        min_split_amount: u64::MAX,
        fee_bps: 1_000,
        fee_recipient: [8u8; 32],
        status: pin::SeriesStatus::Paused,
        bump: 254,
    }
}

/// Extremes on purpose: the fields most likely to be mis-sized are the wide
/// signed ones, and a mid-range value would round-trip through a wrong width.
#[test]
fn a_series_config_written_here_reads_back_under_anchor() {
    let mine = sample_config();
    let mut buf = vec![0u8; pin::SERIES_CONFIG_LEN];
    mine.store(&mut buf).unwrap();

    let parsed = series::state::SeriesConfig::try_deserialize(&mut buf.as_slice()).unwrap();
    assert_eq!(parsed.factory.to_bytes(), mine.factory);
    assert_eq!(parsed.admin.to_bytes(), mine.admin);
    assert_eq!(parsed.collateral_mint.to_bytes(), mine.collateral_mint);
    assert_eq!(parsed.collateral_vault.to_bytes(), mine.collateral_vault);
    assert_eq!(parsed.oracle_adapter.to_bytes(), mine.oracle_adapter);
    assert_eq!(parsed.p_mint.to_bytes(), mine.p_mint);
    assert_eq!(parsed.n_mint.to_bytes(), mine.n_mint);
    assert_eq!(parsed.strike, mine.strike);
    assert_eq!(parsed.price_decimals, mine.price_decimals);
    assert_eq!(parsed.collateral_decimals, mine.collateral_decimals);
    assert_eq!(parsed.multiplier_at_creation, mine.multiplier_at_creation);
    assert_eq!(parsed.maturity_ts, mine.maturity_ts);
    assert_eq!(parsed.settlement_delay_secs, mine.settlement_delay_secs);
    assert_eq!(parsed.max_oracle_age_secs, mine.max_oracle_age_secs);
    assert_eq!(parsed.max_price_lag_secs, mine.max_price_lag_secs);
    assert_eq!(parsed.min_split_amount, mine.min_split_amount);
    assert_eq!(parsed.fee_bps, mine.fee_bps);
    assert_eq!(parsed.fee_recipient.to_bytes(), mine.fee_recipient);
    assert_eq!(parsed.bump, mine.bump);

    // ...and back through this build unchanged.
    assert_eq!(PinConfig::load(&buf).unwrap(), mine);
}

fn sample_settlement() -> PinSettlement {
    PinSettlement {
        series: [9u8; 32],
        price: -1,
        price_decimals: 8,
        price_ts: i64::MAX,
        settled_ts: i64::MIN,
        collateral_at_settlement: 1,
        p_supply_at_settlement: 2,
        n_supply_at_settlement: 3,
        p_pool: 4,
        n_pool: 5,
        p_redeemed: 6,
        n_redeemed: 7,
        p_paid: 8,
        n_paid: u64::MAX,
        multiplier_at_settlement: i128::MIN,
        effective_strike: i128::MAX,
        shortfall_observed: true,
        supply_mismatch: false,
        bump: 250,
    }
}

#[test]
fn a_settlement_written_here_reads_back_under_anchor() {
    let mine = sample_settlement();
    let mut buf = vec![0u8; pin::SETTLEMENT_LEN];
    mine.store(&mut buf).unwrap();

    let parsed = series::state::Settlement::try_deserialize(&mut buf.as_slice()).unwrap();
    assert_eq!(parsed.series.to_bytes(), mine.series);
    assert_eq!(parsed.price, mine.price);
    assert_eq!(parsed.price_decimals, mine.price_decimals);
    assert_eq!(parsed.price_ts, mine.price_ts);
    assert_eq!(parsed.settled_ts, mine.settled_ts);
    assert_eq!(
        parsed.collateral_at_settlement,
        mine.collateral_at_settlement
    );
    assert_eq!(parsed.p_supply_at_settlement, mine.p_supply_at_settlement);
    assert_eq!(parsed.n_supply_at_settlement, mine.n_supply_at_settlement);
    assert_eq!(parsed.p_pool, mine.p_pool);
    assert_eq!(parsed.n_pool, mine.n_pool);
    assert_eq!(parsed.p_redeemed, mine.p_redeemed);
    assert_eq!(parsed.n_redeemed, mine.n_redeemed);
    assert_eq!(parsed.p_paid, mine.p_paid);
    assert_eq!(parsed.n_paid, mine.n_paid);
    assert_eq!(
        parsed.multiplier_at_settlement,
        mine.multiplier_at_settlement
    );
    assert_eq!(parsed.effective_strike, mine.effective_strike);
    assert_eq!(parsed.shortfall_observed, mine.shortfall_observed);
    assert_eq!(parsed.supply_mismatch, mine.supply_mismatch);
    assert_eq!(parsed.bump, mine.bump);

    assert_eq!(PinSettlement::load(&buf).unwrap(), mine);
}

// --- Rejection ------------------------------------------------------------

#[test]
fn every_truncation_is_rejected() {
    let mut buf = vec![0u8; pin::SERIES_CONFIG_LEN];
    sample_config().store(&mut buf).unwrap();
    for n in 0..buf.len() {
        assert!(
            PinConfig::load(&buf[..n]).is_err(),
            "truncation to {n} accepted"
        );
    }
    // Trailing bytes are tolerated, as Anchor tolerates them.
    let mut longer = buf.clone();
    longer.extend_from_slice(&[0xAB; 21]);
    assert!(PinConfig::load(&longer).is_ok());
}

#[test]
fn a_foreign_discriminator_is_rejected() {
    let mut buf = vec![0u8; pin::SERIES_CONFIG_LEN];
    sample_config().store(&mut buf).unwrap();
    for byte in 0..8 {
        for bit in 0..8 {
            let mut bad = buf.clone();
            bad[byte] ^= 1 << bit;
            assert!(PinConfig::load(&bad).is_err(), "flip {byte}:{bit} accepted");
        }
    }
    // And a settlement must never read as a config.
    assert!(PinSettlement::load(&buf).is_err());
}

#[test]
fn an_out_of_range_status_tag_is_rejected() {
    let mut buf = vec![0u8; pin::SERIES_CONFIG_LEN];
    sample_config().store(&mut buf).unwrap();
    // The status sits immediately before the bump, at the end of the body.
    let at = pin::SERIES_CONFIG_LEN - 2;
    for tag in 3u8..=255 {
        buf[at] = tag;
        assert!(PinConfig::load(&buf).is_err(), "status tag {tag} accepted");
    }
}

proptest! {
    /// Arbitrary bytes must never panic either loader.
    #[test]
    fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..600)) {
        let _ = PinConfig::load(&bytes);
        let _ = PinSettlement::load(&bytes);
    }
}

// --- The linkage the port rests on ----------------------------------------

/// The port calls `common::math` rather than reimplementing it, which is only
/// meaningful if it is genuinely the same code the Anchor build calls. Compared
/// through `series`' own re-export path.
#[test]
fn the_math_is_the_same_code_the_anchor_build_uses() {
    let cases: [(i128, i128, i128); 4] = [
        (1_000_000, 500_000, 750_000),
        (0, 1, 1),
        (i64::MAX as i128, 1, 1),
        (7, 3, 11),
    ];
    for (collateral, strike, price) in cases {
        assert_eq!(
            series_pinocchio::math::compute_pools(collateral, strike, price),
            common::math::compute_pools(collateral, strike, price),
        );
        assert_eq!(
            series_pinocchio::math::compute_redeem(collateral, strike, price),
            common::math::compute_redeem(collateral, strike, price),
        );
        assert_eq!(
            series_pinocchio::math::apply_shortfall(collateral, strike, price),
            common::math::apply_shortfall(collateral, strike, price),
        );
    }
}

// --- Error codes ----------------------------------------------------------

/// The port's whole error surface is one offset.
///
/// Because `common` is linked rather than reimplemented there is no second enum
/// to keep in step and no transcribed index to drift — the only thing that
/// could be wrong is the 6000 Anchor adds when one of these surfaces on chain.
/// Checked against Anchor's own conversion, for every variant the program can
/// return, rather than against a copy of the number.
#[test]
fn error_codes_match_anchors_own_conversion() {
    use common::OptionsError;
    let variants = [
        OptionsError::AlreadyInitialized,
        OptionsError::Unauthorized,
        OptionsError::InvalidAmount,
        OptionsError::AmountTooSmall,
        OptionsError::InvalidStrike,
        OptionsError::InvalidMaturity,
        OptionsError::InvalidOracle,
        OptionsError::SeriesClosed,
        OptionsError::SeriesPaused,
        OptionsError::SeriesNotMatured,
        OptionsError::SettlementTooEarly,
        OptionsError::AlreadySettled,
        OptionsError::NotSettled,
        OptionsError::OraclePriceInvalid,
        OptionsError::OraclePriceStale,
        OptionsError::InsufficientCollateral,
        OptionsError::MathOverflow,
        OptionsError::DustSweepTooEarly,
        OptionsError::InvalidDecimals,
        OptionsError::InvalidParams,
    ];

    for v in variants {
        // What Anchor reports for this variant, through its own machinery.
        let anchor_code = match anchor_lang::error::Error::from(v) {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("expected an AnchorError, got {other:?}"),
        };
        // What the port emits.
        let ported = match series_pinocchio::error::err(v) {
            pinocchio::error::ProgramError::Custom(c) => c,
            other => panic!("expected Custom, got {other:?}"),
        };
        assert_eq!(ported, anchor_code, "{v:?}");
    }
}
