// SPDX-License-Identifier: Apache-2.0
//! The matching engine, ported from `market::logic`.
//!
//! Every branch mirrors the Anchor build condition for condition and *in the
//! same order*. That ordering is observable: a caller who trips two checks at
//! once sees whichever fires first, and `tests/conformance.rs` drives both
//! engines through identical operation sequences and compares the error code as
//! well as the resulting book.
//!
//! The operations run against [`BookView`] rather than a deserialised struct,
//! so only one `Slot` or `Order` is on the stack at a time. See the type's own
//! documentation for why: the materialised book is 6,472 bytes and Solana caps
//! a stack frame at 4,096.

use crate::{
    error::MarketError,
    state::{BookView, Order, Slot, BASE_UNIT, MAX_ORDERS},
};

/// Trading-side actions are valid strictly before maturity. Cancellation,
/// rollup exit, and withdrawal deliberately do not call this guard.
pub fn require_open_at(maturity_ts: i64, now: i64) -> Result<(), MarketError> {
    if now >= maturity_ts {
        return Err(MarketError::MarketClosed);
    }
    Ok(())
}

/// Quote owed for `qty` base at `price`, rounded **up**.
///
/// Rounding up is deliberate and always against the buyer: a bid can never lock
/// less quote than the fill will cost, so a partial fill can never leave a slot
/// short. The most it costs anyone is one atomic unit of quote per fill.
pub fn quote_cost(price: u64, qty: u64) -> Result<u64, MarketError> {
    let num = (price as u128)
        .checked_mul(qty as u128)
        .ok_or(MarketError::MathOverflow)?;
    let rounded = num
        .checked_add(BASE_UNIT - 1)
        .ok_or(MarketError::MathOverflow)?
        / BASE_UNIT;
    u64::try_from(rounded).map_err(|_| MarketError::MathOverflow)
}

impl BookView<'_> {
    pub fn slot_index(&self, owner: &[u8; 32]) -> Option<usize> {
        (0..self.slots_len()).find(|&i| {
            let s = self.slot(i);
            s.occupied && &s.owner == owner
        })
    }

    /// Find a trader's slot, opening one if they have none.
    pub fn slot_for(&mut self, owner: &[u8; 32]) -> Result<usize, MarketError> {
        if let Some(i) = self.slot_index(owner) {
            return Ok(i);
        }
        // Reuse a slot that was emptied by a full withdrawal before growing.
        let free = (0..self.slots_len()).find(|&i| !self.slot(i).occupied);
        let fresh = Slot {
            owner: *owner,
            occupied: true,
            ..Default::default()
        };
        if let Some(i) = free {
            self.set_slot(i, &fresh);
            return Ok(i);
        }
        self.push_slot(&fresh)
    }

    /// Release a slot once it holds nothing. Keeps the table from filling up
    /// with traders who have long since withdrawn.
    pub fn release_if_empty(&mut self, index: usize) {
        let s = self.slot(index);
        if s.total_base() == 0 && s.total_quote() == 0 {
            self.set_slot(index, &Slot::default());
        }
    }

    /// Rest a limit order, locking the funds it commits.
    ///
    /// Locking at placement rather than at fill is what makes a resting order
    /// honest: the book can never advertise depth the trader cannot cover.
    pub fn place(
        &mut self,
        owner: &[u8; 32],
        is_bid: bool,
        price: u64,
        qty: u64,
    ) -> Result<u64, MarketError> {
        if qty == 0 {
            return Err(MarketError::InvalidAmount);
        }
        if price == 0 {
            return Err(MarketError::InvalidPrice);
        }
        if self.orders_len() >= MAX_ORDERS {
            return Err(MarketError::BookFull);
        }
        let next_order_id = self
            .next_order_id()
            .checked_add(1)
            .ok_or(MarketError::MathOverflow)?;

        let idx = self.slot_for(owner)?;
        let mut slot = self.slot(idx);
        if is_bid {
            let cost = quote_cost(price, qty)?;
            if slot.quote_free < cost {
                return Err(MarketError::InsufficientBalance);
            }
            slot.quote_free -= cost;
            slot.quote_locked = slot
                .quote_locked
                .checked_add(cost)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            if slot.base_free < qty {
                return Err(MarketError::InsufficientBalance);
            }
            slot.base_free -= qty;
            slot.base_locked = slot
                .base_locked
                .checked_add(qty)
                .ok_or(MarketError::MathOverflow)?;
        }
        self.set_slot(idx, &slot);

        let id = self.next_order_id();
        self.set_next_order_id(next_order_id);
        self.push_order(&Order {
            id,
            trader: idx as u8,
            is_bid,
            price,
            remaining: qty,
            active: true,
        })?;
        Ok(id)
    }

    fn order_index(&self, id: u64) -> Result<usize, MarketError> {
        (0..self.orders_len())
            .find(|&i| {
                let o = self.order(i);
                o.active && o.id == id
            })
            .ok_or(MarketError::OrderNotFound)
    }

    /// Cancel a resting order and unlock whatever it still commits.
    pub fn cancel(&mut self, owner: &[u8; 32], id: u64) -> Result<(), MarketError> {
        let oi = self.order_index(id)?;
        let order = self.order(oi);
        let slot_idx = order.trader as usize;
        let mut slot = self.slot(slot_idx);
        if &slot.owner != owner {
            return Err(MarketError::NotOrderOwner);
        }

        if order.is_bid {
            let refund = quote_cost(order.price, order.remaining)?;
            slot.quote_locked = slot.quote_locked.saturating_sub(refund);
            slot.quote_free = slot
                .quote_free
                .checked_add(refund)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            slot.base_locked = slot
                .base_locked
                .checked_sub(order.remaining)
                .ok_or(MarketError::MathOverflow)?;
            slot.base_free = slot
                .base_free
                .checked_add(order.remaining)
                .ok_or(MarketError::MathOverflow)?;
        }
        self.set_slot(slot_idx, &slot);

        self.swap_remove_order(oi);
        Ok(())
    }

    /// Cross a taker against one resting order for up to `qty` base.
    ///
    /// Fills at the **maker's** price, which is the only choice that makes a
    /// resting order safe to leave on the book: whatever the taker asks for,
    /// the maker gets exactly the terms they committed to.
    pub fn fill(&mut self, taker: &[u8; 32], id: u64, qty: u64) -> Result<u64, MarketError> {
        if qty == 0 {
            return Err(MarketError::InvalidAmount);
        }

        let oi = self.order_index(id)?;
        let order = self.order(oi);
        let maker_idx = order.trader as usize;
        if &self.slot(maker_idx).owner == taker {
            return Err(MarketError::SelfFill);
        }

        let taker_idx = self.slot_for(taker)?;
        let filled = qty.min(order.remaining);
        let cost = quote_cost(order.price, filled)?;

        // Read both sides before writing either: the maker and taker are
        // distinct slots, but reading through the view twice after a partial
        // write would see a half-updated book.
        let mut taker_slot = self.slot(taker_idx);
        let mut maker_slot = self.slot(maker_idx);

        if order.is_bid {
            // Maker is buying: taker delivers base and receives quote.
            if taker_slot.base_free < filled {
                return Err(MarketError::InsufficientBalance);
            }
            taker_slot.base_free -= filled;
            taker_slot.quote_free = taker_slot
                .quote_free
                .checked_add(cost)
                .ok_or(MarketError::MathOverflow)?;

            maker_slot.quote_locked = maker_slot.quote_locked.saturating_sub(cost);
            maker_slot.base_free = maker_slot
                .base_free
                .checked_add(filled)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            // Maker is selling: taker delivers quote and receives base.
            if taker_slot.quote_free < cost {
                return Err(MarketError::InsufficientBalance);
            }
            taker_slot.quote_free -= cost;
            taker_slot.base_free = taker_slot
                .base_free
                .checked_add(filled)
                .ok_or(MarketError::MathOverflow)?;

            maker_slot.base_locked = maker_slot
                .base_locked
                .checked_sub(filled)
                .ok_or(MarketError::MathOverflow)?;
            maker_slot.quote_free = maker_slot
                .quote_free
                .checked_add(cost)
                .ok_or(MarketError::MathOverflow)?;
        }
        self.set_slot(taker_idx, &taker_slot);
        self.set_slot(maker_idx, &maker_slot);

        let mut updated = self.order(oi);
        updated.remaining -= filled;
        if updated.remaining == 0 {
            self.swap_remove_order(oi);
        } else {
            self.set_order(oi, &updated);
        }
        self.set_volume_base(self.volume_base().saturating_add(filled));
        Ok(filled)
    }

    /// Totals across every slot, for asserting against the vaults.
    ///
    /// Deliberately not saturating: the Anchor build adds with `+`, so an
    /// overflow there would panic, and a port that quietly saturated would be
    /// the more dangerous of the two.
    pub fn totals(&self) -> (u64, u64) {
        (0..self.slots_len()).fold((0u64, 0u64), |(b, q), i| {
            let s = self.slot(i);
            (b + s.total_base(), q + s.total_quote())
        })
    }
}
