// SPDX-License-Identifier: Apache-2.0
//! Error codes, pinned to the Anchor variant's numbering.
//!
//! `market::logic::MarketError` is its own `#[error_code]` enum -- not
//! `common::OptionsError` -- so it numbers from 6000 independently, in
//! declaration order. A client cannot tell which framework built the program it
//! is talking to, so the same condition has to return the same number from
//! either. Checked against the real enum in `tests/conformance.rs`.

use pinocchio::error::ProgramError;

/// Anchor reserves 6000..=6999 for user-defined errors.
const ANCHOR_ERROR_BASE: u32 = 6000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MarketError {
    InvalidAmount = 0,
    InvalidPrice = 1,
    BookFull = 2,
    NoSlot = 3,
    UnknownTrader = 4,
    InsufficientBalance = 5,
    OrderNotFound = 6,
    NotOrderOwner = 7,
    SelfFill = 8,
    MathOverflow = 9,
    MarketClosed = 10,
}

impl From<MarketError> for ProgramError {
    fn from(e: MarketError) -> Self {
        ProgramError::Custom(ANCHOR_ERROR_BASE + e as u32)
    }
}
