// SPDX-License-Identifier: Apache-2.0
//! Order book for a series' P and N tokens — Pinocchio variant.
//!
//! Semantically identical to `programs/market` (the Anchor build): same program
//! id, same account layouts, same instruction encoding, same error codes. It
//! exists because deploy rent is `(bytes + 173) * 6960` lamports and nothing
//! else.
//!
//! # What changes without Anchor
//!
//! Anchor's `#[derive(Accounts)]` generates the ownership, signer, writable,
//! PDA and `has_one` checks. None of that exists here, so every one of them is
//! written out in [`program::accounts`] -- and in this program one of them is
//! load-bearing in a way that is easy to miss: `deposit` and `withdraw` take
//! the book as `Account<'info, Book>`, and while it is delegated it is owned by
//! the delegation program, so the owner check fails and neither can run. That
//! is what stops the rollup's ledger and the vaults from diverging, and it was
//! free in Anchor.
//!
//! The MagicBlock payloads are rebuilt in [`delegation`] rather than called
//! through the SDK, which is written against `solana_account_info::AccountInfo`
//! rather than Pinocchio's `AccountView`. Two of the three are serialised with
//! bincode against a positional, unversioned enum, so every byte is asserted
//! equal to the SDK's own output in `tests/delegation_wire.rs`.

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

pub mod delegation;
pub mod error;
pub mod events;
pub mod logic;
pub mod program;
pub mod state;
pub mod token;

pinocchio_pubkey::declare_id!("FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC");

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(program::process_instruction);
// A real `#[panic_handler]` and no allocator: this crate is genuinely `no_std`
// and nothing in it allocates.
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::no_allocator!();
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

/// Anchor instruction discriminators: `sha256("global:<snake_case_name>")[..8]`.
/// Derived in the tests rather than trusted as literals. Listed here so the
/// instruction layer has one place to build against, and so the conformance
/// suite can pin them before anything dispatches on them.
pub mod ix {
    pub const INITIALIZE_MARKET: [u8; 8] = [35, 35, 189, 193, 155, 48, 170, 203];
    pub const INITIALIZE_BOOK: [u8; 8] = [229, 238, 30, 198, 244, 0, 186, 239];
    pub const DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
    pub const WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
    pub const PLACE_ORDER: [u8; 8] = [51, 194, 155, 175, 109, 130, 96, 106];
    pub const CANCEL_ORDER: [u8; 8] = [95, 129, 237, 240, 8, 49, 223, 132];
    pub const FILL_ORDER: [u8; 8] = [232, 122, 115, 25, 199, 143, 136, 162];
    pub const DELEGATE_BOOK: [u8; 8] = [175, 120, 231, 223, 36, 212, 159, 143];
    pub const COMMIT_BOOK: [u8; 8] = [97, 13, 159, 245, 44, 27, 66, 174];
    pub const UNDELEGATE_BOOK: [u8; 8] = [122, 145, 114, 28, 40, 87, 180, 254];
    /// Injected by `#[ephemeral]`; the rollup calls this back on exit.
    pub const PROCESS_UNDELEGATION: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
}
