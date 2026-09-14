// SPDX-License-Identifier: Apache-2.0
//!
//! The quote path, driven against the Anchor oracle crate.
//!
//! The Pyth fixtures are the shared `tests/fixtures/pyth-*.json` account
//! snapshots. For each one this suite builds the Anchor `FeedConfig` naming
//! it, calls the Anchor `read_quote_at_or_after` and this build's equivalent,
//! and asserts the same quote — or the same error code — comes back. Failure
//! modes are covered by mutating the inputs, not by trusting either side.

use {
    anchor_lang::{AnchorSerialize, Discriminator, Space},
    series_pinocchio::oracle as qo,
    solana_account_info::AccountInfo,
    solana_pubkey::Pubkey,
};

fn receiver() -> Pubkey {
    Pubkey::new_from_array(qo::PYTH_RECEIVER_ID)
}

fn load_fixture(name: &str) -> (Pubkey, Pubkey, Vec<u8>) {
    let path = format!(
        "{}/../../tests/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(&path).expect("read pyth fixture");
    let json: serde_json::Value = serde_json::from_str(&raw).expect("parse fixture");
    let pubkey: Pubkey = json["pubkey"].as_str().unwrap().parse().unwrap();
    let owner: Pubkey = json["account"]["owner"].as_str().unwrap().parse().unwrap();
    let (encoding, data) = (&json["account"]["data"][1], &json["account"]["data"][0]);
    assert_eq!(encoding.as_str().unwrap(), "base64");
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data.as_str().unwrap(),
    )
    .unwrap();
    (pubkey, owner, bytes)
}

fn feed_config(feed_id: [u8; 32], source: Pubkey) -> oracle_adapter::FeedConfig {
    oracle_adapter::FeedConfig {
        admin: Pubkey::new_unique(),
        feed_id,
        source,
        max_age_secs: 120,
        min_verification_signatures: 1,
        bump: 255,
    }
}

fn config_bytes(cfg: &oracle_adapter::FeedConfig) -> Vec<u8> {
    let mut bytes = oracle_adapter::FeedConfig::DISCRIMINATOR.to_vec();
    bytes.extend(cfg.try_to_vec().unwrap());
    bytes
}

/// Map either build's outcome to a comparable shape: the quote fields, or the
/// on-chain error code.
fn anchor_outcome(
    result: Result<common::PriceData, anchor_lang::error::Error>,
) -> Result<(Vec<u8>, i128, u32, i64), u32> {
    result
        .map(|quote| {
            (
                quote.feed_id.to_vec(),
                quote.price,
                quote.decimals,
                quote.timestamp,
            )
        })
        .map_err(|error| match error {
            anchor_lang::error::Error::AnchorError(anchor) => anchor.error_code_number,
            other => panic!("unexpected non-anchor error: {other:?}"),
        })
}

fn port_outcome(
    result: Result<qo::PriceData, common::OptionsError>,
) -> Result<(Vec<u8>, i128, u32, i64), u32> {
    result
        .map(|quote| {
            (
                quote.feed_id.to_vec(),
                quote.price,
                quote.decimals,
                quote.timestamp,
            )
        })
        // Through Anchor's own conversion, so the code is derived, not
        // transcribed: whatever number Anchor assigns this variant is the
        // number asserted.
        .map_err(|error| match anchor_lang::error::Error::from(error) {
            anchor_lang::error::Error::AnchorError(anchor) => anchor.error_code_number,
            other => panic!("unexpected non-anchor error: {other:?}"),
        })
}

fn both(
    cfg: &oracle_adapter::FeedConfig,
    source_key: Pubkey,
    source_owner: Pubkey,
    source_lamports: &mut u64,
    source_data: &mut Vec<u8>,
    now: i64,
    after_ts: i64,
    max_age: i64,
) -> (
    Result<(Vec<u8>, i128, u32, i64), u32>,
    Result<(Vec<u8>, i128, u32, i64), u32>,
) {
    // The port borrows immutably; Anchor's AccountInfo needs a mutable
    // borrow. Port first so the borrows do not overlap.
    let bytes = config_bytes(cfg);
    let view = qo::read_feed_config(&oracle_adapter::ID.to_bytes(), &bytes).unwrap();
    let port = port_outcome(qo::read_quote_at_or_after(
        &view,
        &source_key.to_bytes(),
        &source_owner.to_bytes(),
        source_data,
        now,
        after_ts,
        max_age,
    ));

    let source_info = AccountInfo::new(
        &source_key,
        false,
        false,
        source_lamports,
        source_data,
        &source_owner,
        false,
        0,
    );
    let anchor = anchor_outcome(oracle_adapter::read_quote_at_or_after(
        cfg,
        &source_info,
        now,
        after_ts,
        max_age,
    ));
    (anchor, port)
}

#[test]
fn wire_constants_match_anchor() {
    assert_eq!(
        qo::ORACLE_ADAPTER_PROGRAM_ID,
        oracle_adapter::ID.to_bytes(),
        "oracle program id drifted"
    );
    assert_eq!(
        qo::FEED_CONFIG_DISCRIMINATOR,
        oracle_adapter::FeedConfig::DISCRIMINATOR,
        "feed config discriminator drifted"
    );
    assert_eq!(
        qo::FEED_CONFIG_LEN,
        8 + oracle_adapter::FeedConfig::INIT_SPACE,
        "feed config length drifted"
    );
    // The framework codes mirror Anchor's own numbering.
    use anchor_lang::error::ErrorCode;
    assert_eq!(
        qo::framework_code::OWNED_BY_WRONG_PROGRAM,
        ErrorCode::AccountOwnedByWrongProgram as u32
    );
    assert_eq!(
        qo::framework_code::DISCRIMINATOR_NOT_FOUND,
        ErrorCode::AccountDiscriminatorNotFound as u32
    );
    assert_eq!(
        qo::framework_code::DISCRIMINATOR_MISMATCH,
        ErrorCode::AccountDiscriminatorMismatch as u32
    );
    assert_eq!(
        qo::framework_code::DID_NOT_DESERIALIZE,
        ErrorCode::AccountDidNotDeserialize as u32
    );
}

#[test]
fn feed_config_parse_matches_anchor() {
    let cfg = feed_config([7u8; 32], Pubkey::new_unique());
    let bytes = config_bytes(&cfg);
    let view = qo::read_feed_config(&oracle_adapter::ID.to_bytes(), &bytes).unwrap();
    assert_eq!(view.feed_id, &cfg.feed_id);
    assert_eq!(view.source, &cfg.source.to_bytes());
    assert_eq!(view.max_age_secs, cfg.max_age_secs);
    assert_eq!(
        view.min_verification_signatures,
        cfg.min_verification_signatures
    );

    // Wrong owner, short account, foreign discriminator and truncated body
    // fail with Anchor's own framework codes.
    let wrong_owner = Pubkey::new_unique().to_bytes();
    assert_eq!(
        qo::read_feed_config(&wrong_owner, &bytes).unwrap_err(),
        pinocchio::error::ProgramError::Custom(3007)
    );
    assert_eq!(
        qo::read_feed_config(&oracle_adapter::ID.to_bytes(), &bytes[..7]).unwrap_err(),
        pinocchio::error::ProgramError::Custom(3001)
    );
    let mut bad_disc = bytes.clone();
    bad_disc[0] ^= 0xff;
    assert_eq!(
        qo::read_feed_config(&oracle_adapter::ID.to_bytes(), &bad_disc).unwrap_err(),
        pinocchio::error::ProgramError::Custom(3002)
    );
    assert_eq!(
        qo::read_feed_config(&oracle_adapter::ID.to_bytes(), &bytes[..100]).unwrap_err(),
        pinocchio::error::ProgramError::Custom(3003)
    );
}

const FIXTURES: &[&str] = &[
    "pyth-at-600",
    "pyth-at-600-alt",
    "pyth-at-600-past",
    "pyth-at-300",
    "pyth-live",
    "pyth-stale",
];

#[test]
fn quotes_match_anchor_on_every_fixture() {
    for name in FIXTURES {
        let (pubkey, owner, data) = load_fixture(name);
        // Name this source in the config by reading its feed id first, so the
        // suite follows the fixtures instead of pinning their contents.
        let probe = qo::decode_pyth(&owner.to_bytes(), &data, 0).unwrap();
        let cfg = feed_config(probe.feed_id, pubkey);
        let now = probe.timestamp + 30;
        let mut lamports = 0u64;
        let mut bytes = data.clone();
        let (anchor, port) = both(
            &cfg,
            pubkey,
            owner,
            &mut lamports,
            &mut bytes,
            now,
            probe.timestamp,
            120,
        );
        assert_eq!(anchor, port, "fixture {name} diverged");
    }
}

#[test]
fn quote_failure_modes_match_anchor() {
    let (pubkey, owner, data) = load_fixture("pyth-at-600");
    let probe = qo::decode_pyth(&owner.to_bytes(), &data, 0).unwrap();
    assert_eq!(owner, receiver(), "fixture must be receiver-owned");
    let cfg = feed_config(probe.feed_id, pubkey);

    // A different account behind the same config.
    let other = Pubkey::new_unique();
    let mut lamports = 0u64;
    let mut bytes = data.clone();
    let (anchor, port) = both(
        &cfg,
        other,
        owner,
        &mut lamports,
        &mut bytes,
        probe.timestamp + 30,
        probe.timestamp,
        120,
    );
    assert_eq!(anchor, port);
    assert_eq!(anchor.unwrap_err(), 6000 + 35); // FeedMismatch

    // A foreign owner.
    let foreign = Pubkey::new_unique();
    let (anchor, port) = both(
        &cfg,
        pubkey,
        foreign,
        &mut lamports,
        &mut bytes,
        probe.timestamp + 30,
        probe.timestamp,
        120,
    );
    assert_eq!(anchor, port);

    // A stale quote.
    let (anchor, port) = both(
        &cfg,
        pubkey,
        owner,
        &mut lamports,
        &mut bytes,
        probe.timestamp + 10_000,
        probe.timestamp,
        120,
    );
    assert_eq!(anchor, port);

    // Truncated source bytes fail on both.
    let mut short = data[..60].to_vec();
    let (anchor, port) = both(
        &cfg,
        pubkey,
        owner,
        &mut lamports,
        &mut short,
        probe.timestamp + 30,
        probe.timestamp,
        120,
    );
    assert_eq!(anchor, port);
    assert!(anchor.is_err());
}
