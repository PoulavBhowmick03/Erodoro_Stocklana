// SPDX-License-Identifier: Apache-2.0
//! Every byte `src/delegation.rs` produces, checked against the SDK that owns
//! the format.
//!
//! This is the mitigation the port owes. Two of the three payloads are not
//! self-describing: `ScheduleIntentBundle` is a `serde` enum serialised with
//! bincode, and its variant index is counted by *position* in an enum owned by
//! MagicBlock, with no version tag. A hand-encoded build that gets it wrong
//! does not fail to compile and does not fail at run time in any obvious way --
//! it invokes a different instruction.
//!
//! So the numbers are not trusted. `MagicBlockInstruction` and
//! `MagicIntentBundleArgs` are constructed here through the SDK's own types,
//! serialised with the SDK's own bincode call, and compared byte for byte. Bump
//! the SDK and insert a variant upstream and this test goes red, which is the
//! same property `sha256("global:<name>")` gives the Anchor discriminators
//! everywhere else in these ports.

use {
    bincode::serialize,
    magicblock_magic_program_api::{
        args::{CommitTypeArgs, MagicIntentBundleArgs},
        instruction::MagicBlockInstruction,
    },
    market_pinocchio::delegation::{self, Intent},
};

/// The account index the bundle refers to. Arbitrary -- what matters is that
/// both encoders put it in the same place.
const IDX: u8 = 2;

fn sdk_bundle(commit: bool) -> Vec<u8> {
    let args = if commit {
        MagicIntentBundleArgs {
            commit: Some(CommitTypeArgs::Standalone(vec![IDX])),
            ..Default::default()
        }
    } else {
        MagicIntentBundleArgs {
            commit_and_undelegate: Some(
                magicblock_magic_program_api::args::CommitAndUndelegateArgs {
                    commit_type: CommitTypeArgs::Standalone(vec![IDX]),
                    undelegate_type:
                        magicblock_magic_program_api::args::UndelegateTypeArgs::Standalone,
                },
            ),
            ..Default::default()
        }
    };
    serialize(&MagicBlockInstruction::ScheduleIntentBundle(args)).expect("sdk serialises")
}

#[test]
fn the_commit_payload_matches_the_sdk() {
    let mine = delegation::schedule_intent_bundle(Intent::Commit, IDX).unwrap();
    assert_eq!(
        mine.as_slice(),
        sdk_bundle(true).as_slice(),
        "commit payload diverged from the SDK"
    );
}

#[test]
fn the_undelegate_payload_matches_the_sdk() {
    let mine = delegation::schedule_intent_bundle(Intent::CommitAndUndelegate, IDX).unwrap();
    assert_eq!(
        mine.as_slice(),
        sdk_bundle(false).as_slice(),
        "commit-and-undelegate payload diverged from the SDK"
    );
}

/// The variant index on its own, so a failure says *which* assumption broke
/// rather than only that the bytes differ.
#[test]
fn the_schedule_intent_bundle_variant_index_is_still_eleven() {
    let bytes = sdk_bundle(true);
    let index = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    assert_eq!(
        index,
        delegation::SCHEDULE_INTENT_BUNDLE,
        "MagicBlockInstruction gained or lost a variant ahead of \
         ScheduleIntentBundle; the hand-encoded index must be updated"
    );
}

#[test]
fn the_delegate_payload_matches_the_sdk() {
    use ephemeral_rollups_sdk::types::DelegateAccountArgs;

    // The shape `delegate_book` actually sends: default commit frequency, the
    // book's own seeds, no pinned validator.
    let market = [7u8; 32];
    let seeds: Vec<Vec<u8>> = vec![b"book".to_vec(), market.to_vec(), vec![1u8]];
    let args = DelegateAccountArgs {
        commit_frequency_ms: u32::MAX,
        seeds: seeds.clone(),
        validator: None,
    };

    let mut expected = delegation::DELEGATE_DISCRIMINATOR.to_le_bytes().to_vec();
    borsh::to_writer(&mut expected, &args).expect("sdk serialises");

    let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let mine = delegation::delegate(u32::MAX, &refs, None).unwrap();
    assert_eq!(
        mine.as_slice(),
        expected.as_slice(),
        "delegate payload diverged from the SDK"
    );
}

#[test]
fn a_pinned_validator_round_trips() {
    use ephemeral_rollups_sdk::types::DelegateAccountArgs;

    let validator = [9u8; 32];
    let seeds: Vec<Vec<u8>> = vec![b"book".to_vec()];
    let args = DelegateAccountArgs {
        commit_frequency_ms: 1_000,
        seeds: seeds.clone(),
        validator: Some(ephemeral_rollups_sdk::compat::Pubkey::new_from_array(
            validator,
        )),
    };
    let mut expected = delegation::DELEGATE_DISCRIMINATOR.to_le_bytes().to_vec();
    borsh::to_writer(&mut expected, &args).expect("sdk serialises");

    let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let mine = delegation::delegate(1_000, &refs, Some(&validator)).unwrap();
    assert_eq!(mine.as_slice(), expected.as_slice());
}

/// The addresses, read from the SDK rather than transcribed.
#[test]
fn the_magicblock_addresses_match_the_sdk() {
    assert_eq!(
        delegation::MAGIC_PROGRAM_ID,
        ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID.to_bytes(),
    );
    assert_eq!(
        delegation::MAGIC_CONTEXT_ID,
        ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID.to_bytes(),
    );
    assert_eq!(
        delegation::DELEGATION_PROGRAM_ID,
        ephemeral_rollups_sdk::id().to_bytes(),
    );
}
