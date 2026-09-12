// SPDX-License-Identifier: Apache-2.0
//! Error codes, pinned to the Anchor variant's numbering.
//!
//! `common::OptionsError` is an Anchor `#[error_code]` enum, so its
//! discriminants start at 6000 and are assigned by declaration order. A client
//! cannot tell which framework built the program it is talking to, so the
//! variants must return the *same* number for the same condition.

use quasar_lang::prelude::ProgramError;

/// Anchor reserves 6000..=6999 for user-defined errors.
const ANCHOR_ERROR_BASE: u32 = 6000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OptionsError {
    Unauthorized = 2,
    InvalidOracle = 7,
    OraclePriceInvalid = 15,
    OraclePriceStale = 16,
    OracleDecimalsInvalid = 18,
    MathOverflow = 21,
    InvalidDecimals = 25,
    InvalidParams = 26,
    FeedMismatch = 35,
}

impl From<OptionsError> for ProgramError {
    fn from(e: OptionsError) -> Self {
        ProgramError::Custom(ANCHOR_ERROR_BASE + e as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The numbers a client sees. If `common::OptionsError` ever gains a
    /// variant *before* one of these, this test is what catches the silent
    /// renumbering.
    #[test]
    fn codes_match_the_anchor_variant() {
        let cases = [
            (OptionsError::Unauthorized, 6002),
            (OptionsError::InvalidOracle, 6007),
            (OptionsError::OraclePriceInvalid, 6015),
            (OptionsError::OraclePriceStale, 6016),
            (OptionsError::OracleDecimalsInvalid, 6018),
            (OptionsError::MathOverflow, 6021),
            (OptionsError::InvalidDecimals, 6025),
            (OptionsError::InvalidParams, 6026),
            (OptionsError::FeedMismatch, 6035),
        ];
        for (err, expected) in cases {
            match ProgramError::from(err) {
                ProgramError::Custom(code) => assert_eq!(code, expected, "{err:?}"),
                other => panic!("expected Custom, got {other:?}"),
            }
        }
    }
}
