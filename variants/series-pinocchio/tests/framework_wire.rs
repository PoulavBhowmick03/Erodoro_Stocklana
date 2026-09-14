// SPDX-License-Identifier: Apache-2.0
//!
//! Every framework code this port replicates, checked against Anchor's own
//! `ErrorCode` enum — plus the instruction discriminators, derived from the
//! handler names the way Anchor derives them.

use {anchor_lang::error::ErrorCode, series_pinocchio::program as prog, sha2::{Digest, Sha256}};

fn anchor_derived(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

#[test]
fn instruction_discriminators_are_the_anchor_derivations() {
    let cases = [
        ("create_series", prog::ix::CREATE_SERIES),
        ("split", prog::ix::SPLIT),
        ("merge", prog::ix::MERGE),
        ("settle", prog::ix::SETTLE),
        ("redeem_p", prog::ix::REDEEM_P),
        ("redeem_n", prog::ix::REDEEM_N),
        ("pause_splits", prog::ix::PAUSE_SPLITS),
        ("unpause_splits", prog::ix::UNPAUSE_SPLITS),
        ("renounce_admin", prog::ix::RENOUNCE_ADMIN),
        ("sweep_dust", prog::ix::SWEEP_DUST),
    ];
    assert_eq!(cases.len(), 10);
    for (name, discriminator) in cases {
        assert_eq!(
            anchor_derived(name),
            discriminator,
            "discriminator for {name} does not match sha256(\"global:{name}\")[..8]"
        );
    }
}

#[test]
fn framework_codes_match_anchor() {
    assert_eq!(
        prog::framework_code::INSTRUCTION_DID_NOT_DESERIALIZE,
        ErrorCode::InstructionDidNotDeserialize as u32
    );
    assert_eq!(
        prog::framework_code::NOT_ENOUGH_KEYS,
        ErrorCode::AccountNotEnoughKeys as u32
    );
    assert_eq!(
        prog::framework_code::INVALID_PROGRAM_ID,
        ErrorCode::InvalidProgramId as u32
    );
    assert_eq!(
        prog::framework_code::NOT_INITIALIZED,
        ErrorCode::AccountNotInitialized as u32
    );
    assert_eq!(
        prog::framework_code::OWNED_BY_WRONG_PROGRAM,
        ErrorCode::AccountOwnedByWrongProgram as u32
    );
}
