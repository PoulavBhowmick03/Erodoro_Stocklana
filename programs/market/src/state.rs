// SPDX-License-Identifier: Apache-2.0
//! Account layouts for the P/N order book.
//!
//! One design decision shapes all of these: **the entire hot path lives in a
//! single account**. Orders and trader balances sit together in [`Book`], so a
//! session delegates exactly one account to the ephemeral rollup and every
//! match is a mutation of that one account. Splitting balances into per-trader
//! PDAs would be more Solana-idiomatic on L1 and much worse here — each match
//! would need both sides' accounts delegated to the same validator, and a
//! trader whose account was undelegated mid-session could not be filled
//! against.

use anchor_lang::prelude::*;

/// Which leg of a series this book trades.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub enum Leg {
    /// The capped claim. The covered writer holds this.
    P,
    /// The upside above the strike. This is the one that needs a buyer.
    N,
}

impl Leg {
    pub fn tag(&self) -> u8 {
        match self {
            Leg::P => 0,
            Leg::N => 1,
        }
    }
}

/// How many traders one book can hold, and how many live orders.
///
/// Both are fixed because the account is delegated wholesale to a rollup;
/// reallocating a delegated account is not a thing. 32 and 128 keep the
/// account near 6 KB, comfortably inside what a validator will clone quickly.
pub const MAX_TRADERS: usize = 32;
pub const MAX_ORDERS: usize = 128;

/// Price is quote raw units per whole unit of base.
///
/// The current market wire format assumes that P and N have 8 decimals, so one
/// whole unit is 1e8 raw. `initialize_market` does not yet enforce that
/// assumption or require a 6-decimal USDC quote mint. Until the market is
/// bound to `SeriesConfig`, callers must treat both as deployment preconditions.
/// With those preconditions, a price of 15_000_000 is $15.00 per P.
pub const BASE_UNIT: u128 = 100_000_000;

/// One trader's escrowed balance. Credited by `deposit` on L1, moved around by
/// matching in the rollup, drawn down by `withdraw` on L1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct Slot {
    pub owner: Pubkey,
    /// Base (P or N) available to sell or withdraw.
    pub base_free: u64,
    /// Base committed to resting asks.
    pub base_locked: u64,
    /// Quote tokens available to bid or withdraw.
    pub quote_free: u64,
    /// Quote committed to resting bids.
    pub quote_locked: u64,
    /// False for an unused slot. `owner` alone cannot say, since the default
    /// pubkey is a legal value.
    pub occupied: bool,
}

impl Slot {
    pub fn total_base(&self) -> u64 {
        self.base_free.saturating_add(self.base_locked)
    }
    pub fn total_quote(&self) -> u64 {
        self.quote_free.saturating_add(self.quote_locked)
    }
}

/// A resting limit order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct Order {
    pub id: u64,
    /// Index into [`Book::slots`].
    pub trader: u8,
    pub is_bid: bool,
    /// Quote raw units per [`BASE_UNIT`] of base.
    pub price: u64,
    /// Base raw units still unfilled.
    pub remaining: u64,
    pub active: bool,
}

/// The order book, balances included.
///
/// This is the account that gets delegated. While it is delegated it is owned
/// by the delegation program, so every L1 instruction that touches it —
/// `deposit`, `withdraw` — fails Anchor's owner check automatically. That is
/// not a convenience: it is the property that stops the rollup's view of a
/// balance and the vault's actual contents from diverging.
#[account]
#[derive(InitSpace)]
pub struct Book {
    pub market: Pubkey,
    pub leg: Leg,
    #[max_len(MAX_TRADERS)]
    pub slots: Vec<Slot>,
    #[max_len(MAX_ORDERS)]
    pub orders: Vec<Order>,
    pub next_order_id: u64,
    /// Cumulative base matched. Survives commits, so it is the honest measure
    /// of whether anyone is actually trading this leg.
    pub volume_base: u64,
    pub bump: u8,
}

/// Immutable wiring for one series' two books.
///
/// Never delegated. It names the mints and vaults, and nothing about it
/// changes once created, so there is no reason to put it in a rollup.
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// The `series::SeriesConfig` these legs belong to.
    pub series: Pubkey,
    pub p_mint: Pubkey,
    pub n_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub p_vault: Pubkey,
    pub n_vault: Pubkey,
    pub quote_vault: Pubkey,
    /// Copied from the series at creation. Trading stops here — after
    /// settlement P and N are claims on a frozen pool, not instruments.
    pub maturity_ts: i64,
    pub bump: u8,
}

impl Market {
    pub fn base_mint(&self, leg: Leg) -> Pubkey {
        match leg {
            Leg::P => self.p_mint,
            Leg::N => self.n_mint,
        }
    }

    pub fn base_vault(&self, leg: Leg) -> Pubkey {
        match leg {
            Leg::P => self.p_vault,
            Leg::N => self.n_vault,
        }
    }
}
