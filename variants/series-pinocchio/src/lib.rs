// SPDX-License-Identifier: Apache-2.0
//! Option series — Pinocchio variant.
//!
//! Semantically identical to `programs/series` (the Anchor build): same program
//! id, same account layouts, same instruction encoding, same error codes. It
//! exists because deploy rent is `(bytes + 173) * 6960` lamports and nothing
//! else.
//!
//! What exists here beyond the dependency decision, measured rather than
//! assumed: this crate links `common::math` instead of reimplementing it. See
//! `variants/COMPARISON.md` for the numbers and the reasoning.
//!
//! The consequence is visible in the manifest and is not free. `common`'s error
//! enum is an Anchor `#[error_code]`, so `anchor-lang` and `solana-program`
//! come with it — and `solana-program` supplies its own global allocator and
//! panic handler. This crate therefore **cannot** use `no_allocator!` or
//! `nostd_panic_handler!` the way its three siblings do; declaring them is a
//! `duplicate lang item panic_impl` error, not a stylistic choice.
//!
//! Measured against a minimal Pinocchio program: 18,696 bytes with
//! `common::math` linked against 4,760 without. 13,936 bytes, 0.0970 SOL.

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

pub mod accounts;
pub mod collateral;
pub mod error;
pub mod events;
pub mod logic;
pub mod oracle;
pub mod program;
pub mod state;
pub mod token;
pub mod transfer;

pub use common::math;

pinocchio_pubkey::declare_id!("AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9");

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(program::process_instruction);
// NOTE: no `no_allocator!` / `nostd_panic_handler!` here, unlike the three
// sibling ports. This crate links `common`, whose Anchor error enum pulls
// `anchor-lang` and `solana-program`, which supply their own global allocator
// and panic handler; declaring ours is a `duplicate lang item` error. The
// runtime costs nothing measurable -- taking `common` without `anchor` produced
// a byte-identical binary -- but the lang items it defines are not ours to
// redeclare, so the macros stay out.

// --- The test suite -------------------------------------------------------
//
// `tests/` is compiled into this crate rather than as separate integration
// crates. Cargo only enables `lto` for a unit whose crate types can all be
// linked with it, and an rlib cannot, so `crate-type = ["cdylib", "lib"]` made
// `lto = "fat"` a silent no-op. The artifact is `cdylib`-only now, which means
// cargo builds no rlib for the suite to link against, so the suite is included
// here with `autotests = false` in the manifest keeping cargo from also trying
// to build it as six integration-test binaries.
//
// `extern crate self as series_pinocchio` keeps every existing
// `series_pinocchio::` path in those files resolving unchanged. The files stay
// where they are; only how they are compiled changed.
#[cfg(test)]
extern crate self as series_pinocchio;

#[cfg(test)]
#[path = "../tests/conformance.rs"]
mod conformance;
#[cfg(test)]
#[path = "../tests/events_wire.rs"]
mod events_wire;
#[cfg(test)]
#[path = "../tests/framework_wire.rs"]
mod framework_wire;
#[cfg(test)]
#[path = "../tests/oracle_wire.rs"]
mod oracle_wire;
#[cfg(test)]
#[path = "../tests/token_wire.rs"]
mod token_wire;
#[cfg(test)]
#[path = "../tests/transfer_wire.rs"]
mod transfer_wire;
