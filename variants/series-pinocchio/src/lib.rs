// SPDX-License-Identifier: Apache-2.0
//! Option series — Pinocchio variant. **Scaffold only; nothing is ported yet.**
//!
//! What exists here is the dependency decision, measured rather than assumed:
//! this crate links `common::math` instead of reimplementing it. See
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

#![allow(unexpected_cfgs)]

pub mod accounts;
pub mod error;
pub mod state;

pub use common::math;

pinocchio_pubkey::declare_id!("AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9");
