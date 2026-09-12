// SPDX-License-Identifier: Apache-2.0
//! The MagicBlock wire formats, rebuilt.
//!
//! `ephemeral_rollups_sdk` has no Anchor coupling, but it is written against
//! `solana_account_info::AccountInfo` rather than Pinocchio's `AccountView`, so
//! its instruction builders cannot be called from here. The payloads are
//! rebuilt instead -- and, because two of them are *not* self-describing, every
//! byte this module produces is asserted equal to the SDK's own output in
//! `tests/delegation_wire.rs`.
//!
//! # Why that test is not optional
//!
//! `delegate` is honest: a `u64` discriminator followed by borsh. Borsh is
//! positional too, but `DelegateAccountArgs` is a struct this repo can see.
//!
//! `commit` and `undelegate` are not. They serialise
//! `MagicBlockInstruction::ScheduleIntentBundle` with **bincode**, and the
//! variant index is a `u32` counted by position in a `serde` enum owned by
//! MagicBlock, with no version tag. Insert a variant ahead of it upstream and a
//! hand-encoded build keeps emitting the old number and silently invokes
//! whatever now sits there -- where the Anchor build would simply recompile
//! against the new SDK and stay correct.
//!
//! Anchor discriminators do not have this failure mode: `sha256("global:<name>")`
//! is derived from a *name*. The equivalence test is what buys the same
//! property here -- it fails the moment the SDK moves.

use crate::error::MarketError;

/// The three MagicBlock addresses this program talks to. Decoded from base58
/// at compile time rather than transcribed as bytes, and checked against the
/// SDK's own constants in `tests/delegation_wire.rs`.
pub const MAGIC_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("Magic11111111111111111111111111111111111111");
pub const MAGIC_CONTEXT_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("MagicContext1111111111111111111111111111111");
pub const DELEGATION_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/// Seed tags the delegation program derives its own PDAs from.
pub const DELEGATE_BUFFER_TAG: &[u8] = b"buffer";
pub const DELEGATION_RECORD_TAG: &[u8] = b"delegation";

/// Bincode's `Option` tag: one byte, 0 for `None` and 1 for `Some`.
const NONE: u8 = 0;
const SOME: u8 = 1;

/// `MagicBlockInstruction::ScheduleIntentBundle`, by position in the enum.
///
/// This is the number the doc comment above is about. It is checked against the
/// SDK rather than trusted.
pub const SCHEDULE_INTENT_BUNDLE: u32 = 11;

/// `CommitTypeArgs::Standalone`, likewise by position.
pub const COMMIT_TYPE_STANDALONE: u32 = 0;

/// `UndelegateTypeArgs::Standalone`. `CommitAndUndelegateArgs` carries *two*
/// enums -- a commit type and an undelegate type -- and the second is easy to
/// miss reading the builder, which is exactly what the equivalence test caught.
pub const UNDELEGATE_TYPE_STANDALONE: u32 = 0;

/// `DelegationProgram::Delegate`, the `u64` discriminator `cpi_delegate` uses.
pub const DELEGATE_DISCRIMINATOR: u64 = 0;

/// Widest payload this module builds: the bundle args with one committed
/// account.
pub const MAX_INTENT_LEN: usize = 4 + 1 + 4 + 8 + 1 + 4 + 1 + 1 + 1 + 8;

/// A fixed-capacity byte builder, so nothing here allocates.
pub struct Buf<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Buf<N> {
    pub fn new() -> Self {
        Self {
            bytes: [0u8; N],
            len: 0,
        }
    }

    fn put(&mut self, src: &[u8]) -> Result<(), MarketError> {
        let end = self
            .len
            .checked_add(src.len())
            .ok_or(MarketError::MathOverflow)?;
        if end > N {
            return Err(MarketError::MathOverflow);
        }
        self.bytes[self.len..end].copy_from_slice(src);
        self.len = end;
        Ok(())
    }

    fn u8(&mut self, v: u8) -> Result<(), MarketError> {
        self.put(&[v])
    }

    fn u32(&mut self, v: u32) -> Result<(), MarketError> {
        self.put(&v.to_le_bytes())
    }

    fn u64(&mut self, v: u64) -> Result<(), MarketError> {
        self.put(&v.to_le_bytes())
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// Which of the two bundle intents to schedule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Intent {
    /// Push the ledger to L1 and keep the session open.
    Commit,
    /// Push it and end the session, returning the account to this program.
    CommitAndUndelegate,
}

/// Build `MagicBlockInstruction::ScheduleIntentBundle` for a single committed
/// account at `account_index` in the instruction's account list.
///
/// bincode, with the default fixed-width little-endian configuration:
/// enum variants are a `u32` index, `Option` is a one-byte tag, and `Vec` is a
/// `u64` length followed by its elements.
pub fn schedule_intent_bundle(
    intent: Intent,
    account_index: u8,
) -> Result<Buf<MAX_INTENT_LEN>, MarketError> {
    let mut b = Buf::<MAX_INTENT_LEN>::new();
    b.u32(SCHEDULE_INTENT_BUNDLE)?;

    // MagicIntentBundleArgs, field by field. Exactly one of the first two is
    // populated; `market` never schedules the `finalize` variants or standalone
    // actions.
    let commit_first = intent == Intent::Commit;

    // commit: Option<CommitTypeArgs>
    if commit_first {
        b.u8(SOME)?;
        b.u32(COMMIT_TYPE_STANDALONE)?;
        b.u64(1)?; // Vec<u8> length
        b.u8(account_index)?;
    } else {
        b.u8(NONE)?;
    }

    // commit_and_undelegate: Option<CommitAndUndelegateArgs>, which is a
    // `commit_type` *and* an `undelegate_type`.
    if commit_first {
        b.u8(NONE)?;
    } else {
        b.u8(SOME)?;
        b.u32(COMMIT_TYPE_STANDALONE)?;
        b.u64(1)?;
        b.u8(account_index)?;
        b.u32(UNDELEGATE_TYPE_STANDALONE)?;
    }

    b.u8(NONE)?; // commit_finalize
    b.u8(NONE)?; // commit_finalize_and_undelegate
    b.u64(0)?; // standalone_actions: Vec<BaseActionArgs>
    Ok(b)
}

/// Widest `delegate` payload: discriminator, commit frequency, one seed of at
/// most 40 bytes, and an absent validator.
pub const MAX_DELEGATE_LEN: usize = 8 + 4 + 4 + (4 + 64) * 3 + 1 + 32;

/// Build the delegation program's `Delegate` instruction data.
///
/// Borsh, not bincode: `u64` discriminator, then `DelegateAccountArgs`
/// (`commit_frequency_ms: u32`, `seeds: Vec<Vec<u8>>`, `validator:
/// Option<Pubkey>`). Borsh writes a `Vec` as a `u32` length then its elements,
/// and an `Option` as a one-byte tag.
pub fn delegate(
    commit_frequency_ms: u32,
    seeds: &[&[u8]],
    validator: Option<&[u8; 32]>,
) -> Result<Buf<MAX_DELEGATE_LEN>, MarketError> {
    let mut b = Buf::<MAX_DELEGATE_LEN>::new();
    b.u64(DELEGATE_DISCRIMINATOR)?;
    b.u32(commit_frequency_ms)?;
    b.u32(seeds.len() as u32)?;
    for seed in seeds {
        b.u32(seed.len() as u32)?;
        b.put(seed)?;
    }
    match validator {
        Some(v) => {
            b.u8(SOME)?;
            b.put(v)?;
        }
        None => b.u8(NONE)?,
    }
    Ok(b)
}
