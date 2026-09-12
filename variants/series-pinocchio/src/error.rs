// SPDX-License-Identifier: Apache-2.0
//! Turning `common::OptionsError` into the code a client sees.
//!
//! `common`'s enum is an Anchor `#[error_code]`. Anchor adds a 6000 offset when
//! one surfaces on-chain, so the first variant is reported as 6000 rather than
//! 0. Pinocchio has no such convention, so the offset is applied here.
//!
//! This is the *whole* error surface of the port: because `common` is linked
//! rather than reimplemented, there is no second enum to keep in step and no
//! transcribed index to drift. The one thing that could still be wrong is this
//! offset, and `tests/conformance.rs` checks it against Anchor's own
//! conversion for every variant the program can return.

use {common::OptionsError, pinocchio::error::ProgramError};

/// Anchor reserves 6000..=6999 for user-defined errors.
pub const ANCHOR_ERROR_BASE: u32 = 6000;

/// The on-chain code for one of `common`'s errors.
pub fn err(e: OptionsError) -> ProgramError {
    ProgramError::Custom(ANCHOR_ERROR_BASE + e as u32)
}
