// SPDX-License-Identifier: Apache-2.0
//! Types exchanged between programs.
//!
//! Account layouts live with the program that owns them. What is here is the
//! vocabulary two programs have to agree on: the shape of a validated quote
//! and the lifecycle of a series.

use anchor_lang::prelude::*;

/// Lifecycle status of a series.
///
/// `Paused` blocks new splits but
/// deliberately still allows `merge`, so a pause can never trap collateral.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub enum SeriesStatus {
    /// Splits and merges allowed; not yet settled.
    Open,
    /// Splits blocked; merges still allowed; not yet settled.
    Paused,
    /// Settled. Redemptions allowed; splits and merges blocked.
    Settled,
}

/// A normalized, validated quote returned by the oracle adapter.
///
/// `decimals` is the scale `price` is expressed in as it leaves the adapter;
/// the series re-scales it to its own `price_decimals` with the shared
/// `normalize_decimals`, so the two never have to agree in advance.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub struct PriceData {
    /// Identity of the feed that produced the quote. Checked against the
    /// series config so a series can never settle against the wrong asset.
    pub feed_id: [u8; 32],
    pub price: i128,
    pub decimals: u32,
    /// Publish time reported by the source, not the slot the read happened in.
    pub timestamp: i64,
}
