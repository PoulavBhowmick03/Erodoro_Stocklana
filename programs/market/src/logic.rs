// SPDX-License-Identifier: Apache-2.0
//! Matching and balance arithmetic, with no accounts involved.
//!
//! Same split as the `series` program: the instruction handlers are thin, and
//! everything that decides who owns what lives here so it can be tested on the
//! host. That matters more than usual for a book, because the failure mode is
//! not a revert — it is two traders' balances quietly disagreeing with what
//! the vaults hold.
//!
//! The invariant every function below preserves: **for each asset, the sum of
//! every slot's free and locked balance is exactly what the vault holds.**
//! Matching moves value between slots; it never creates or destroys any.

use anchor_lang::prelude::*;

use crate::state::{Book, Order, Slot, BASE_UNIT, MAX_ORDERS, MAX_TRADERS};

#[error_code]
pub enum MarketError {
    #[msg("amount must be positive")]
    InvalidAmount,
    #[msg("price must be positive")]
    InvalidPrice,
    #[msg("book is full")]
    BookFull,
    #[msg("no free trader slot")]
    NoSlot,
    #[msg("trader has no slot in this book")]
    UnknownTrader,
    #[msg("insufficient free balance")]
    InsufficientBalance,
    #[msg("order not found")]
    OrderNotFound,
    #[msg("not the owner of this order")]
    NotOrderOwner,
    #[msg("an order cannot fill itself")]
    SelfFill,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("the series has matured; P and N are claims now, not instruments")]
    MarketClosed,
}

/// Trading-side actions are valid strictly before maturity. Cancellation,
/// rollup exit, and withdrawal deliberately do not call this guard.
pub fn require_open_at(maturity_ts: i64, now: i64) -> Result<()> {
    require!(now < maturity_ts, MarketError::MarketClosed);
    Ok(())
}

/// Quote owed for `qty` base at `price`, rounded **up**.
///
/// Rounding up is deliberate and always against the buyer: it means a bid can
/// never lock less quote than the fill will cost, so a partial fill can never
/// leave a slot short. The most it costs anyone is one atomic unit of quote
/// per fill.
pub fn quote_cost(price: u64, qty: u64) -> Result<u64> {
    let num = (price as u128)
        .checked_mul(qty as u128)
        .ok_or(MarketError::MathOverflow)?;
    let rounded = num
        .checked_add(BASE_UNIT - 1)
        .ok_or(MarketError::MathOverflow)?
        / BASE_UNIT;
    u64::try_from(rounded).map_err(|_| error!(MarketError::MathOverflow))
}

impl Book {
    pub fn slot_index(&self, owner: &Pubkey) -> Option<usize> {
        self.slots
            .iter()
            .position(|s| s.occupied && s.owner == *owner)
    }

    /// Find a trader's slot, opening one if they have none.
    pub fn slot_for(&mut self, owner: &Pubkey) -> Result<usize> {
        if let Some(i) = self.slot_index(owner) {
            return Ok(i);
        }
        // Reuse a slot that was emptied by a full withdrawal before growing.
        if let Some(i) = self.slots.iter().position(|s| !s.occupied) {
            self.slots[i] = Slot {
                owner: *owner,
                occupied: true,
                ..Default::default()
            };
            return Ok(i);
        }
        require!(self.slots.len() < MAX_TRADERS, MarketError::NoSlot);
        self.slots.push(Slot {
            owner: *owner,
            occupied: true,
            ..Default::default()
        });
        Ok(self.slots.len() - 1)
    }

    /// Release a slot once it holds nothing. Keeps the table from filling up
    /// with traders who have long since withdrawn.
    pub fn release_if_empty(&mut self, index: usize) {
        let s = &mut self.slots[index];
        if s.total_base() == 0 && s.total_quote() == 0 {
            *s = Slot::default();
        }
    }

    /// Rest a limit order, locking the funds it commits.
    ///
    /// Locking at placement rather than at fill is what makes a resting order
    /// honest: the book can never advertise depth the trader cannot cover.
    pub fn place(&mut self, owner: &Pubkey, is_bid: bool, price: u64, qty: u64) -> Result<u64> {
        require!(qty > 0, MarketError::InvalidAmount);
        require!(price > 0, MarketError::InvalidPrice);
        require!(self.orders.len() < MAX_ORDERS, MarketError::BookFull);
        let next_order_id = self
            .next_order_id
            .checked_add(1)
            .ok_or(MarketError::MathOverflow)?;

        let idx = self.slot_for(owner)?;
        if is_bid {
            let cost = quote_cost(price, qty)?;
            let slot = &mut self.slots[idx];
            require!(slot.quote_free >= cost, MarketError::InsufficientBalance);
            slot.quote_free -= cost;
            slot.quote_locked = slot
                .quote_locked
                .checked_add(cost)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            let slot = &mut self.slots[idx];
            require!(slot.base_free >= qty, MarketError::InsufficientBalance);
            slot.base_free -= qty;
            slot.base_locked = slot
                .base_locked
                .checked_add(qty)
                .ok_or(MarketError::MathOverflow)?;
        }

        let id = self.next_order_id;
        self.next_order_id = next_order_id;
        self.orders.push(Order {
            id,
            trader: idx as u8,
            is_bid,
            price,
            remaining: qty,
            active: true,
        });
        Ok(id)
    }

    fn order_index(&self, id: u64) -> Result<usize> {
        self.orders
            .iter()
            .position(|o| o.active && o.id == id)
            .ok_or(error!(MarketError::OrderNotFound))
    }

    /// Cancel a resting order and unlock whatever it still commits.
    pub fn cancel(&mut self, owner: &Pubkey, id: u64) -> Result<()> {
        let oi = self.order_index(id)?;
        let order = self.orders[oi];
        let slot_idx = order.trader as usize;
        require!(
            self.slots[slot_idx].owner == *owner,
            MarketError::NotOrderOwner
        );

        if order.is_bid {
            let refund = quote_cost(order.price, order.remaining)?;
            let slot = &mut self.slots[slot_idx];
            slot.quote_locked = slot.quote_locked.saturating_sub(refund);
            slot.quote_free = slot
                .quote_free
                .checked_add(refund)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            let slot = &mut self.slots[slot_idx];
            slot.base_locked = slot
                .base_locked
                .checked_sub(order.remaining)
                .ok_or(MarketError::MathOverflow)?;
            slot.base_free = slot
                .base_free
                .checked_add(order.remaining)
                .ok_or(MarketError::MathOverflow)?;
        }

        self.orders.swap_remove(oi);
        Ok(())
    }

    /// Cross a taker against one resting order for up to `qty` base.
    ///
    /// Fills at the **maker's** price, which is the only choice that makes a
    /// resting order safe to leave on the book: whatever the taker asks for,
    /// the maker gets exactly the terms they committed to.
    pub fn fill(&mut self, taker: &Pubkey, id: u64, qty: u64) -> Result<u64> {
        require!(qty > 0, MarketError::InvalidAmount);

        let oi = self.order_index(id)?;
        let order = self.orders[oi];
        let maker_idx = order.trader as usize;
        require!(self.slots[maker_idx].owner != *taker, MarketError::SelfFill);

        let taker_idx = self.slot_for(taker)?;
        let filled = qty.min(order.remaining);
        let cost = quote_cost(order.price, filled)?;

        if order.is_bid {
            // Maker is buying: taker delivers base and receives quote.
            require!(
                self.slots[taker_idx].base_free >= filled,
                MarketError::InsufficientBalance
            );
            self.slots[taker_idx].base_free -= filled;
            self.slots[taker_idx].quote_free = self.slots[taker_idx]
                .quote_free
                .checked_add(cost)
                .ok_or(MarketError::MathOverflow)?;

            let maker = &mut self.slots[maker_idx];
            maker.quote_locked = maker.quote_locked.saturating_sub(cost);
            maker.base_free = maker
                .base_free
                .checked_add(filled)
                .ok_or(MarketError::MathOverflow)?;
        } else {
            // Maker is selling: taker delivers quote and receives base.
            require!(
                self.slots[taker_idx].quote_free >= cost,
                MarketError::InsufficientBalance
            );
            self.slots[taker_idx].quote_free -= cost;
            self.slots[taker_idx].base_free = self.slots[taker_idx]
                .base_free
                .checked_add(filled)
                .ok_or(MarketError::MathOverflow)?;

            let maker = &mut self.slots[maker_idx];
            maker.base_locked = maker
                .base_locked
                .checked_sub(filled)
                .ok_or(MarketError::MathOverflow)?;
            maker.quote_free = maker
                .quote_free
                .checked_add(cost)
                .ok_or(MarketError::MathOverflow)?;
        }

        self.orders[oi].remaining -= filled;
        if self.orders[oi].remaining == 0 {
            self.orders.swap_remove(oi);
        }
        self.volume_base = self.volume_base.saturating_add(filled);
        Ok(filled)
    }

    /// Totals across every slot, for asserting against the vaults.
    pub fn totals(&self) -> (u64, u64) {
        self.slots.iter().fold((0, 0), |(b, q), s| {
            (b + s.total_base(), q + s.total_quote())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Leg;

    const ONE: u64 = 100_000_000; // one whole P or N (8 decimals)
    const USDC: u64 = 1_000_000; // one dollar (6 decimals)

    fn book() -> Book {
        Book {
            market: Pubkey::default(),
            leg: Leg::N,
            slots: vec![],
            orders: vec![],
            next_order_id: 1,
            volume_base: 0,
            bump: 0,
        }
    }

    fn fund(b: &mut Book, who: &Pubkey, base: u64, quote: u64) {
        let i = b.slot_for(who).unwrap();
        b.slots[i].base_free += base;
        b.slots[i].quote_free += quote;
    }

    #[test]
    fn quote_cost_rounds_up_against_the_buyer() {
        // 1 whole unit at $15 is exactly $15.
        assert_eq!(quote_cost(15 * USDC, ONE).unwrap(), 15 * USDC);
        // Half a unit is exactly half.
        assert_eq!(quote_cost(15 * USDC, ONE / 2).unwrap(), 15 * USDC / 2);
        // A dust quantity costs one atomic unit rather than nothing, so a
        // buyer can never take base for free.
        assert_eq!(quote_cost(15 * USDC, 1).unwrap(), 1);
    }

    #[test]
    fn trading_side_actions_close_exactly_at_maturity() {
        assert!(require_open_at(1_000, 999).is_ok());
        assert!(require_open_at(1_000, 1_000).is_err());
        assert!(require_open_at(1_000, 1_001).is_err());
    }

    #[test]
    fn placing_locks_funds_and_resting_depth_is_always_covered() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        fund(&mut b, &maker, 0, 100 * USDC);

        b.place(&maker, true, 15 * USDC, ONE).unwrap();
        let s = b.slots[0];
        assert_eq!(s.quote_locked, 15 * USDC, "the bid's cost is locked");
        assert_eq!(s.quote_free, 85 * USDC);
        assert_eq!(s.total_quote(), 100 * USDC, "nothing created or destroyed");
    }

    #[test]
    fn a_bid_beyond_the_balance_is_rejected() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        fund(&mut b, &maker, 0, 10 * USDC);
        assert!(b.place(&maker, true, 15 * USDC, ONE).is_err());
        // And nothing was locked on the way to failing.
        assert_eq!(b.slots[0].quote_free, 10 * USDC);
        assert_eq!(b.slots[0].quote_locked, 0);
    }

    #[test]
    fn cancelling_returns_exactly_what_was_locked() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        fund(&mut b, &maker, ONE, 0);

        let id = b.place(&maker, false, 15 * USDC, ONE).unwrap();
        assert_eq!(b.slots[0].base_locked, ONE);
        b.cancel(&maker, id).unwrap();
        assert_eq!(b.slots[0].base_free, ONE);
        assert_eq!(b.slots[0].base_locked, 0);
        assert!(b.orders.is_empty());
    }

    #[test]
    fn only_the_owner_can_cancel() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        fund(&mut b, &maker, ONE, 0);
        let id = b.place(&maker, false, 15 * USDC, ONE).unwrap();
        assert!(b.cancel(&other, id).is_err());
    }

    #[test]
    fn filling_an_ask_moves_base_one_way_and_quote_the_other() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let taker = Pubkey::new_unique();
        fund(&mut b, &maker, ONE, 0);
        fund(&mut b, &taker, 0, 50 * USDC);

        let id = b.place(&maker, false, 15 * USDC, ONE).unwrap();
        assert_eq!(b.fill(&taker, id, ONE).unwrap(), ONE);

        let m = b.slots[b.slot_index(&maker).unwrap()];
        let t = b.slots[b.slot_index(&taker).unwrap()];
        assert_eq!(m.base_free, 0);
        assert_eq!(m.base_locked, 0);
        assert_eq!(m.quote_free, 15 * USDC, "maker was paid their own price");
        assert_eq!(t.base_free, ONE, "taker received the base");
        assert_eq!(t.quote_free, 35 * USDC);
        assert_eq!(b.volume_base, ONE);
        assert!(b.orders.is_empty(), "a fully filled order leaves the book");
    }

    #[test]
    fn filling_a_bid_moves_value_the_other_way() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let taker = Pubkey::new_unique();
        fund(&mut b, &maker, 0, 50 * USDC);
        fund(&mut b, &taker, ONE, 0);

        let id = b.place(&maker, true, 15 * USDC, ONE).unwrap();
        b.fill(&taker, id, ONE).unwrap();

        let m = b.slots[b.slot_index(&maker).unwrap()];
        let t = b.slots[b.slot_index(&taker).unwrap()];
        assert_eq!(m.base_free, ONE);
        assert_eq!(m.quote_locked, 0);
        assert_eq!(m.quote_free, 35 * USDC);
        assert_eq!(t.quote_free, 15 * USDC);
        assert_eq!(t.base_free, 0);
    }

    #[test]
    fn partial_fills_leave_the_remainder_resting_and_still_covered() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let taker = Pubkey::new_unique();
        fund(&mut b, &maker, 0, 50 * USDC);
        fund(&mut b, &taker, ONE, 0);

        let id = b.place(&maker, true, 15 * USDC, ONE).unwrap();
        b.fill(&taker, id, ONE / 4).unwrap();

        let order = b.orders.iter().find(|o| o.id == id).unwrap();
        assert_eq!(order.remaining, ONE - ONE / 4);

        // What is still locked covers what is still resting.
        let m = b.slots[b.slot_index(&maker).unwrap()];
        assert!(m.quote_locked >= quote_cost(15 * USDC, order.remaining).unwrap());
    }

    #[test]
    fn a_fill_never_exceeds_what_rests() {
        let mut b = book();
        let maker = Pubkey::new_unique();
        let taker = Pubkey::new_unique();
        fund(&mut b, &maker, ONE, 0);
        fund(&mut b, &taker, 0, 100 * USDC);

        let id = b.place(&maker, false, 15 * USDC, ONE).unwrap();
        // Ask for four times the resting size; get exactly the resting size.
        assert_eq!(b.fill(&taker, id, 4 * ONE).unwrap(), ONE);
    }

    #[test]
    fn an_order_cannot_fill_itself() {
        let mut b = book();
        let who = Pubkey::new_unique();
        fund(&mut b, &who, ONE, 100 * USDC);
        let id = b.place(&who, false, 15 * USDC, ONE).unwrap();
        assert!(b.fill(&who, id, ONE).is_err());
    }

    #[test]
    fn value_is_conserved_across_a_run_of_trades() {
        // The property that matters: matching moves value between slots and
        // never creates it. If this drifts, the book and the vaults disagree
        // and somebody eventually cannot withdraw.
        let mut b = book();
        let a = Pubkey::new_unique();
        let c = Pubkey::new_unique();
        fund(&mut b, &a, 3 * ONE, 40 * USDC);
        fund(&mut b, &c, ONE, 90 * USDC);
        let before = b.totals();

        let o1 = b.place(&a, false, 12 * USDC, 2 * ONE).unwrap();
        let o2 = b.place(&c, true, 9 * USDC, ONE).unwrap();
        b.fill(&c, o1, ONE / 2).unwrap();
        b.fill(&a, o2, ONE / 3).unwrap();
        b.cancel(&a, o1).unwrap();
        let o3 = b.place(&c, false, 11 * USDC, ONE / 4).unwrap();
        b.fill(&a, o3, ONE / 4).unwrap();

        let after = b.totals();
        assert_eq!(after.0, before.0, "base conserved");
        assert_eq!(after.1, before.1, "quote conserved");
    }

    #[test]
    fn slots_are_reused_once_emptied() {
        let mut b = book();
        let a = Pubkey::new_unique();
        fund(&mut b, &a, ONE, 0);
        let i = b.slot_index(&a).unwrap();
        b.slots[i].base_free = 0;
        b.release_if_empty(i);
        assert!(!b.slots[i].occupied);

        let c = Pubkey::new_unique();
        assert_eq!(b.slot_for(&c).unwrap(), i, "the freed slot is reused");
    }

    #[test]
    fn the_book_refuses_to_grow_past_its_capacity() {
        let mut b = book();
        // Fill every trader slot.
        for _ in 0..MAX_TRADERS {
            let who = Pubkey::new_unique();
            fund(&mut b, &who, ONE, 0);
        }
        assert!(b.slot_for(&Pubkey::new_unique()).is_err());
    }

    #[test]
    fn order_ids_never_wrap_or_partially_lock_funds() {
        let mut b = book();
        b.next_order_id = u64::MAX;
        let maker = Pubkey::new_unique();
        fund(&mut b, &maker, ONE, 0);

        assert!(b.place(&maker, false, USDC, ONE).is_err());
        let slot = b.slots[b.slot_index(&maker).unwrap()];
        assert_eq!(slot.base_free, ONE);
        assert_eq!(slot.base_locked, 0);
        assert!(b.orders.is_empty());
    }
}
