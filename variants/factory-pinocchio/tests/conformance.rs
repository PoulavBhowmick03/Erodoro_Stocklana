// SPDX-License-Identifier: Apache-2.0
//! The two builds of `factory`, compared against each other.
//!
//! This links **both crates** -- the Anchor `factory` and this Pinocchio port
//! -- and runs them against identical inputs. A cheaper binary is worthless if
//! it behaves differently, and the only way to know is to ask both.
//!
//! Nothing here is transcribed and hoped for. Every discriminator is derived
//! from its preimage, every layout from Anchor's own `InitSpace`, every error
//! code from `common::OptionsError` itself. The `oracle-adapter` port shipped
//! with a program-id test that compared a constant to a literal copy of itself
//! -- it passed for weeks while the two ids genuinely differed, and silently
//! disabled the whole on-validator suite. That is the failure mode this file
//! exists to avoid.

use {
    anchor_lang::{prelude::*, Discriminator, Space},
    factory_pinocchio::{
        error::OptionsError as PinErr,
        events, ix,
        policy::{self, CreateSeriesParams as PinParams},
        series_cpi, state,
    },
    proptest::prelude::*,
    sha2::{Digest, Sha256},
};

/// `sha256(preimage)[..8]`, the derivation Anchor uses everywhere.
fn disc(preimage: &str) -> [u8; 8] {
    let h = Sha256::digest(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

/// Pull the numeric code out of an Anchor error, so the two builds can be
/// compared on the number a client actually sees.
fn anchor_code(e: &anchor_lang::error::Error) -> u32 {
    match e {
        anchor_lang::error::Error::AnchorError(ae) => ae.error_code_number,
        anchor_lang::error::Error::ProgramError(pe) => {
            panic!("expected an AnchorError, got {pe:?}")
        }
    }
}

fn pin_code(e: PinErr) -> u32 {
    match pinocchio::error::ProgramError::from(e) {
        pinocchio::error::ProgramError::Custom(c) => c,
        other => panic!("expected Custom, got {other:?}"),
    }
}

// --- Identity -------------------------------------------------------------

/// Compared against `factory::ID` itself, not a transcribed literal. A PDA
/// derived by either build has to land on the same address.
#[test]
fn program_id_matches_the_anchor_variant() {
    assert_eq!(factory_pinocchio::ID, factory::ID.to_bytes());
}

/// The CPI target, likewise.
#[test]
fn series_program_id_matches() {
    assert_eq!(*series_cpi::SERIES_ID.as_array(), series::ID.to_bytes());
}

#[test]
fn oracle_adapter_id_matches() {
    assert_eq!(
        *factory_pinocchio::ORACLE_ADAPTER_ID.as_array(),
        oracle_adapter_id()
    );
}

fn oracle_adapter_id() -> [u8; 32] {
    // Reached through the Anchor factory's own dependency rather than typed in.
    oracle_adapter::ID.to_bytes()
}

// --- Discriminators -------------------------------------------------------

#[test]
fn instruction_discriminators_match_anchor() {
    let cases = [
        ("global:initialize", ix::INITIALIZE),
        ("global:set_admin", ix::SET_ADMIN),
        ("global:pause_creation", ix::PAUSE_CREATION),
        ("global:unpause_creation", ix::UNPAUSE_CREATION),
        ("global:approve_oracle", ix::APPROVE_ORACLE),
        ("global:revoke_oracle", ix::REVOKE_ORACLE),
        ("global:approve_collateral", ix::APPROVE_COLLATERAL),
        ("global:revoke_collateral", ix::REVOKE_COLLATERAL),
        ("global:create_series", ix::CREATE_SERIES),
    ];
    for (preimage, actual) in cases {
        assert_eq!(disc(preimage), actual, "{preimage}");
    }
}

/// The account discriminators come from Anchor's own `Discriminator` impls, so
/// a rename on either side is caught rather than silently diverging.
#[test]
fn account_discriminators_match_anchor() {
    assert_eq!(
        state::FACTORY_STATE_DISC,
        factory::FactoryState::DISCRIMINATOR
    );
    assert_eq!(state::APPROVAL_DISC, factory::Approval::DISCRIMINATOR);
    assert_eq!(
        state::SERIES_RECORD_DISC,
        factory::SeriesRecord::DISCRIMINATOR
    );
}

#[test]
fn event_discriminators_match_anchor() {
    let cases = [
        ("event:OracleApproved", events::ORACLE_APPROVED_DISC),
        ("event:OracleRevoked", events::ORACLE_REVOKED_DISC),
        ("event:CollateralApproved", events::COLLATERAL_APPROVED_DISC),
        ("event:CollateralRevoked", events::COLLATERAL_REVOKED_DISC),
        ("event:SeriesRegistered", events::SERIES_REGISTERED_DISC),
    ];
    for (preimage, actual) in cases {
        assert_eq!(disc(preimage), actual, "{preimage}");
    }
}

#[test]
fn the_cpi_discriminator_is_the_one_series_answers_to() {
    assert_eq!(series_cpi::CREATE_SERIES_DISC, disc("global:create_series"));
}

// --- Layouts --------------------------------------------------------------

/// Anchor sizes an account as 8 (discriminator) + `InitSpace`.
#[test]
fn account_lengths_match_anchor() {
    assert_eq!(
        state::FACTORY_STATE_LEN,
        8 + factory::FactoryState::INIT_SPACE
    );
    assert_eq!(state::APPROVAL_LEN, 8 + factory::Approval::INIT_SPACE);
    assert_eq!(
        state::SERIES_RECORD_LEN,
        8 + factory::SeriesRecord::INIT_SPACE
    );
}

/// An account written by this build must deserialize under Anchor, field for
/// field. This is the check that would catch a reordered or mis-sized field,
/// which `INIT_SPACE` alone would not.
#[test]
fn a_factory_state_written_here_reads_back_under_anchor() {
    let written = state::FactoryState {
        admin: [7u8; 32],
        paused: true,
        series_count: 0x0123_4567_89ab_cdef,
        bump: 254,
    };
    let mut buf = vec![0u8; state::FACTORY_STATE_LEN];
    written.store(&mut buf).unwrap();

    let parsed = factory::FactoryState::try_deserialize(&mut buf.as_slice()).unwrap();
    assert_eq!(parsed.admin.to_bytes(), written.admin);
    assert_eq!(parsed.paused, written.paused);
    assert_eq!(parsed.series_count, written.series_count);
    assert_eq!(parsed.bump, written.bump);

    // ...and round-trips back through this build unchanged.
    assert_eq!(state::FactoryState::load(&buf).unwrap(), written);
}

#[test]
fn an_approval_written_here_reads_back_under_anchor() {
    let written = state::Approval {
        target: [9u8; 32],
        bump: 251,
    };
    let mut buf = vec![0u8; state::APPROVAL_LEN];
    written.store(&mut buf).unwrap();

    let parsed = factory::Approval::try_deserialize(&mut buf.as_slice()).unwrap();
    assert_eq!(parsed.target.to_bytes(), written.target);
    assert_eq!(parsed.bump, written.bump);
    assert_eq!(state::Approval::load(&buf).unwrap(), written);
}

#[test]
fn a_series_record_written_here_reads_back_under_anchor() {
    let written = state::SeriesRecord {
        series: [1u8; 32],
        collateral_mint: [2u8; 32],
        feed_config: [3u8; 32],
        strike: i128::MIN + 7,
        maturity_ts: -9_223_372_036_854_775_000,
        price_decimals: 14,
        index: u64::MAX - 1,
        bump: 250,
    };
    let mut buf = vec![0u8; state::SERIES_RECORD_LEN];
    written.store(&mut buf).unwrap();

    let parsed = factory::SeriesRecord::try_deserialize(&mut buf.as_slice()).unwrap();
    assert_eq!(parsed.series.to_bytes(), written.series);
    assert_eq!(parsed.collateral_mint.to_bytes(), written.collateral_mint);
    assert_eq!(parsed.feed_config.to_bytes(), written.feed_config);
    assert_eq!(parsed.strike, written.strike);
    assert_eq!(parsed.maturity_ts, written.maturity_ts);
    assert_eq!(parsed.price_decimals, written.price_decimals);
    assert_eq!(parsed.index, written.index);
    assert_eq!(parsed.bump, written.bump);
    assert_eq!(state::SeriesRecord::load(&buf).unwrap(), written);
}

/// A foreign discriminator is refused, which is the other half of what
/// `Account<'info, T>` does for free.
#[test]
fn every_loader_rejects_a_foreign_discriminator() {
    let mut buf = vec![0u8; state::SERIES_RECORD_LEN];
    state::SeriesRecord {
        series: [0u8; 32],
        collateral_mint: [0u8; 32],
        feed_config: [0u8; 32],
        strike: 1,
        maturity_ts: 1,
        price_decimals: 1,
        index: 0,
        bump: 1,
    }
    .store(&mut buf)
    .unwrap();

    // All 64 single-bit flips in the discriminator must be rejected.
    for byte in 0..8 {
        for bit in 0..8 {
            let mut bad = buf.clone();
            bad[byte] ^= 1 << bit;
            assert!(
                state::SeriesRecord::load(&bad).is_err(),
                "flip {byte}:{bit} accepted"
            );
        }
    }
    // And an Approval must never read as a SeriesRecord, or vice versa.
    assert!(state::Approval::load(&buf).is_err());
}

#[test]
fn every_truncation_is_rejected() {
    let mut buf = vec![0u8; state::FACTORY_STATE_LEN];
    state::FactoryState {
        admin: [4u8; 32],
        paused: false,
        series_count: 3,
        bump: 200,
    }
    .store(&mut buf)
    .unwrap();
    for n in 0..buf.len() {
        assert!(
            state::FactoryState::load(&buf[..n]).is_err(),
            "truncation to {n} accepted"
        );
    }
    // A longer account is tolerated -- Anchor ignores trailing bytes too.
    let mut longer = buf.clone();
    longer.extend_from_slice(&[0xAB; 37]);
    assert!(state::FactoryState::load(&longer).is_ok());
}

// --- Error codes ----------------------------------------------------------

/// The numbers a client sees. Read from `common::OptionsError` rather than
/// copied, so a variant inserted ahead of one of these is caught here.
#[test]
fn error_codes_match_the_anchor_variant() {
    use common::OptionsError as A;
    let cases = [
        (PinErr::Unauthorized, A::Unauthorized),
        (PinErr::InvalidStrike, A::InvalidStrike),
        (PinErr::InvalidMaturity, A::InvalidMaturity),
        (PinErr::MathOverflow, A::MathOverflow),
        (PinErr::InvalidDecimals, A::InvalidDecimals),
        (PinErr::InvalidParams, A::InvalidParams),
        (PinErr::CreationPaused, A::CreationPaused),
    ];
    for (pin, anchor) in cases {
        assert_eq!(pin_code(pin), anchor as u32 + 6000, "{pin:?}");
    }
}

// --- Policy, differentially ----------------------------------------------

fn to_anchor(p: &PinParams) -> series::CreateSeriesParams {
    series::CreateSeriesParams {
        strike: p.strike,
        maturity_ts: p.maturity_ts,
        price_decimals: p.price_decimals,
        settlement_delay_secs: p.settlement_delay_secs,
        max_oracle_age_secs: p.max_oracle_age_secs,
        max_price_lag_secs: p.max_price_lag_secs,
        min_split_amount: p.min_split_amount,
        fee_bps: p.fee_bps,
    }
}

/// Both builds must reach the same verdict *and*, when they reject, the same
/// error code -- the order the conditions are tested in is observable.
fn assert_policy_agrees(p: &PinParams, now: i64) {
    let anchor = factory::validate_policy(&to_anchor(p), now);
    let pin = policy::validate_policy(p, now);
    match (anchor, pin) {
        (Ok(()), Ok(())) => {}
        (Err(a), Err(b)) => assert_eq!(
            anchor_code(&a),
            pin_code(b),
            "different rejection for {p:?} at now={now}"
        ),
        (a, b) => panic!("disagreement for {p:?} at now={now}: anchor={a:?} pin={b:?}"),
    }
}

/// The parameter set the e2e suite actually creates a series with.
fn nominal() -> PinParams {
    PinParams {
        strike: 600_0000_0000,
        maturity_ts: 4_000_000_000,
        price_decimals: 8,
        settlement_delay_secs: 300,
        max_oracle_age_secs: 3_600,
        max_price_lag_secs: 3_600,
        min_split_amount: 1,
        fee_bps: 30,
    }
}

#[test]
fn the_nominal_parameters_are_accepted_by_both() {
    let p = nominal();
    assert!(policy::validate_policy(&p, 1_000_000).is_ok());
    assert_policy_agrees(&p, 1_000_000);
}

/// One field pushed out of range at a time, each of which should trip a
/// specific code in both builds.
#[test]
fn each_boundary_is_rejected_identically() {
    let now = 1_000_000i64;
    let mutations: Vec<(&str, Box<dyn Fn(&mut PinParams)>)> = vec![
        ("strike zero", Box::new(|p: &mut PinParams| p.strike = 0)),
        (
            "strike negative",
            Box::new(|p: &mut PinParams| p.strike = -1),
        ),
        (
            "decimals zero",
            Box::new(|p: &mut PinParams| p.price_decimals = 0),
        ),
        (
            "decimals over max",
            Box::new(|p: &mut PinParams| p.price_decimals = policy::MAX_PRICE_DECIMALS + 1),
        ),
        (
            "maturity too near",
            Box::new(move |p: &mut PinParams| p.maturity_ts = now + policy::MIN_TERM_SECS - 1),
        ),
        (
            "settlement delay negative",
            Box::new(|p: &mut PinParams| p.settlement_delay_secs = -1),
        ),
        (
            "settlement delay over max",
            Box::new(|p: &mut PinParams| {
                p.settlement_delay_secs = policy::MAX_SETTLEMENT_DELAY + 1
            }),
        ),
        (
            "oracle age under min",
            Box::new(|p: &mut PinParams| p.max_oracle_age_secs = policy::MIN_ORACLE_AGE - 1),
        ),
        (
            "oracle age over max",
            Box::new(|p: &mut PinParams| p.max_oracle_age_secs = policy::MAX_ORACLE_AGE + 1),
        ),
        (
            "price lag under min",
            Box::new(|p: &mut PinParams| p.max_price_lag_secs = policy::MIN_PRICE_LAG - 1),
        ),
        (
            "price lag over max",
            Box::new(|p: &mut PinParams| p.max_price_lag_secs = policy::MAX_PRICE_LAG + 1),
        ),
        (
            "min split zero",
            Box::new(|p: &mut PinParams| p.min_split_amount = 0),
        ),
        (
            "fee over max",
            Box::new(|p: &mut PinParams| p.fee_bps = policy::MAX_FEE_BPS + 1),
        ),
        (
            "delay exceeds window",
            Box::new(|p: &mut PinParams| {
                p.max_oracle_age_secs = policy::MIN_ORACLE_AGE;
                p.max_price_lag_secs = policy::MIN_PRICE_LAG;
                p.settlement_delay_secs = policy::MIN_PRICE_LAG + policy::MIN_ORACLE_AGE + 1;
            }),
        ),
    ];
    for (name, mutate) in mutations {
        let mut p = nominal();
        mutate(&mut p);
        assert!(
            policy::validate_policy(&p, now).is_err(),
            "{name} should be rejected"
        );
        assert_policy_agrees(&p, now);
    }
}

proptest! {
    /// Arbitrary parameters, unconstrained. Neither build may panic, and they
    /// must always agree -- including on `i64::MAX` maturities and additions
    /// that overflow the settlement window.
    #[test]
    fn arbitrary_parameters_never_disagree(
        strike in any::<i128>(),
        maturity_ts in any::<i64>(),
        price_decimals in any::<u32>(),
        settlement_delay_secs in any::<i64>(),
        max_oracle_age_secs in any::<i64>(),
        max_price_lag_secs in any::<i64>(),
        min_split_amount in any::<u64>(),
        fee_bps in any::<u16>(),
        now in any::<i64>(),
    ) {
        let p = PinParams {
            strike, maturity_ts, price_decimals, settlement_delay_secs,
            max_oracle_age_secs, max_price_lag_secs, min_split_amount, fee_bps,
        };
        assert_policy_agrees(&p, now);
    }

    /// The same, drawn from the region where parameters are plausible, so the
    /// accepting path gets exercised rather than only the first rejection.
    #[test]
    fn realistic_parameters_never_disagree(
        strike in 1i128..1_000_000_000_000,
        offset in 3_600i64..(400 * 86_400),
        price_decimals in 1u32..=14,
        settlement_delay_secs in 0i64..=(30 * 86_400),
        max_oracle_age_secs in 1i64..=(7 * 86_400),
        max_price_lag_secs in 60i64..=(4 * 86_400),
        min_split_amount in 1u64..u64::MAX,
        fee_bps in 0u16..=1_000,
        now in 0i64..2_000_000_000,
    ) {
        let p = PinParams {
            strike,
            maturity_ts: now.saturating_add(offset),
            price_decimals, settlement_delay_secs,
            max_oracle_age_secs, max_price_lag_secs, min_split_amount, fee_bps,
        };
        assert_policy_agrees(&p, now);
    }
}

// --- The CPI payload ------------------------------------------------------

proptest! {
    /// The bytes handed to `series::create_series` must be exactly what Anchor
    /// would have built. This is the check that matters most in the whole file:
    /// a layout slip here would not fail locally, it would quietly create a
    /// series on different terms than the caller asked for.
    #[test]
    fn the_cpi_payload_is_byte_identical_to_anchors(
        strike in any::<i128>(),
        maturity_ts in any::<i64>(),
        price_decimals in any::<u32>(),
        settlement_delay_secs in any::<i64>(),
        max_oracle_age_secs in any::<i64>(),
        max_price_lag_secs in any::<i64>(),
        min_split_amount in any::<u64>(),
        fee_bps in any::<u16>(),
    ) {
        let p = PinParams {
            strike, maturity_ts, price_decimals, settlement_delay_secs,
            max_oracle_age_secs, max_price_lag_secs, min_split_amount, fee_bps,
        };
        let mine = p.encode();
        let anchors = to_anchor(&p).try_to_vec().unwrap();
        prop_assert_eq!(mine.as_slice(), anchors.as_slice());

        // And decoding Anchor's own bytes recovers the same parameters.
        let round = PinParams::decode(&anchors).unwrap();
        prop_assert_eq!(round, p);
    }

    /// Arbitrary bytes must never panic the decoder.
    #[test]
    fn arbitrary_bytes_never_panic_the_decoder(bytes in prop::collection::vec(any::<u8>(), 0..200)) {
        let _ = PinParams::decode(&bytes);
    }
}

#[test]
fn the_params_wire_size_is_what_borsh_produces() {
    let encoded = to_anchor(&nominal()).try_to_vec().unwrap();
    assert_eq!(encoded.len(), policy::CREATE_SERIES_PARAMS_LEN);
}

#[test]
fn every_truncation_of_the_params_is_rejected() {
    let full = to_anchor(&nominal()).try_to_vec().unwrap();
    for n in 0..full.len() {
        assert!(
            PinParams::decode(&full[..n]).is_err(),
            "truncation to {n} accepted"
        );
    }
}

// --- Seeds ----------------------------------------------------------------

/// The seeds are what bind an approval to the thing it vouches for, and a PDA
/// to its program. A changed byte here would silently move every account.
#[test]
fn seeds_match_the_anchor_variant() {
    assert_eq!(state::FACTORY_SEED, factory::FACTORY_SEED);
    assert_eq!(state::ORACLE_SEED, factory::ORACLE_SEED);
    assert_eq!(state::COLLATERAL_SEED, factory::COLLATERAL_SEED);
    assert_eq!(state::RECORD_SEED, factory::RECORD_SEED);
}

/// Policy constants are the factory's whole job; drift between the two builds
/// would mean one accepts a series the other refuses.
#[test]
fn policy_constants_match_the_anchor_variant() {
    assert_eq!(policy::MAX_PRICE_DECIMALS, factory::MAX_PRICE_DECIMALS);
    assert_eq!(policy::MIN_TERM_SECS, factory::MIN_TERM_SECS);
    assert_eq!(policy::MAX_SETTLEMENT_DELAY, factory::MAX_SETTLEMENT_DELAY);
    assert_eq!(policy::MIN_ORACLE_AGE, factory::MIN_ORACLE_AGE);
    assert_eq!(policy::MAX_ORACLE_AGE, factory::MAX_ORACLE_AGE);
    assert_eq!(policy::MIN_PRICE_LAG, factory::MIN_PRICE_LAG);
    assert_eq!(policy::MAX_PRICE_LAG, factory::MAX_PRICE_LAG);
    assert_eq!(policy::MAX_FEE_BPS, factory::MAX_FEE_BPS);
}
