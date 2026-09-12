// SPDX-License-Identifier: Apache-2.0
//! Shared building blocks for the covered-call protocol on tokenized equities.
//!
//! This holds the pieces
//! that must be identical across every program: the [`OptionsError`] table,
//! the integer [`math`] helpers that protect solvency, and the [`types`] two
//! programs have to agree on.
//!
//! # Why this is not under `programs/`
//!
//! The implementation plan lists this as `programs/common`. `anchor build`
//! treats every directory under `programs/` as a deployable program and fails
//! on a crate with no `declare_id!`, so the shared library lives at the
//! workspace root instead. Nothing else about the mapping changes.
//!
//! # Anchor dependency
//!
//! The plan calls for step 1 to be "pure Rust, no Anchor". It depends on
//! `anchor-lang` for exactly two things: `#[error_code]` on [`OptionsError`],
//! so that `?` converts a math failure into a program error with no
//! per-call-site `map_err`, and the serialization derives on [`types`]. The
//! math itself is plain integer arithmetic and its tests run on the host with
//! no validator.

pub mod error;
pub mod math;
pub mod types;

#[cfg(test)]
mod proptests;

pub use error::OptionsError;
pub use math::{
    apply_shortfall, checked_mul_div_ceil, checked_mul_div_floor, compute_pools, compute_redeem,
    effective_strike, multiplier_to_fixed, normalize_decimals, pow10, resolve_multiplier,
    MathResult, MAX_DECIMALS, MAX_MULTIPLIER, MULTIPLIER_SCALE,
};
pub use types::{PriceData, SeriesStatus};
