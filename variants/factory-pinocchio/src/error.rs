// SPDX-License-Identifier: Apache-2.0
//! Error codes, pinned to the Anchor variant's numbering.
//!
//! `common::OptionsError` is an Anchor `#[error_code]` enum, so its
//! discriminants start at 6000 and are assigned by declaration order. A client
//! cannot tell which framework built the program it is talking to, so the
//! variants must return the *same* number for the same condition. These are
//! transcribed from that enum's ordering -- and checked against it in
//! `tests/conformance.rs`, which reads the real enum rather than a copy.

use pinocchio::error::ProgramError;

/// Anchor reserves 6000..=6999 for user-defined errors.
const ANCHOR_ERROR_BASE: u32 = 6000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OptionsError {
    Unauthorized = 2,
    InvalidStrike = 5,
    InvalidMaturity = 6,
    MathOverflow = 21,
    InvalidDecimals = 25,
    InvalidParams = 26,
    CreationPaused = 27,
}

impl From<OptionsError> for ProgramError {
    fn from(e: OptionsError) -> Self {
        ProgramError::Custom(ANCHOR_ERROR_BASE + e as u32)
    }
}
