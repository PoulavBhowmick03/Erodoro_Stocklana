// SPDX-License-Identifier: Apache-2.0
//! Account layouts for the P/N order book, byte-compatible with the Anchor
//! build.
//!
//! One difference in representation, none on the wire. Anchor stores `slots`
//! and `orders` as `Vec<_>` capped by `#[max_len]`; here they are fixed arrays
//! with an explicit length, because this crate is `no_std` and nothing
//! allocates. Borsh encodes a `Vec` as a 4-byte little-endian length followed
//! by that many elements, which is exactly what [`Book::load`] and
//! [`Book::store`] read and write -- so an account written by either build is
//! readable by the other, and the account is still sized at `8 + InitSpace`.
//!
//! The fixed capacity is not a limitation this port introduces: the account is
//! delegated wholesale to a rollup, and reallocating a delegated account is not
//! a thing, so the Anchor build is equally capped.

use crate::error::MarketError;

pub const DISCRIMINATOR_LEN: usize = 8;

pub const MARKET_SEED: &[u8] = b"market";
pub const BOOK_SEED: &[u8] = b"book";

pub const BOOK_DISC: [u8; 8] = [121, 34, 121, 35, 91, 62, 85, 222];
pub const MARKET_DISC: [u8; 8] = [219, 190, 213, 55, 0, 227, 198, 154];

/// How many traders one book can hold, and how many live orders.
pub const MAX_TRADERS: usize = 32;
pub const MAX_ORDERS: usize = 128;

/// Price is quote raw units per whole unit of base.
pub const BASE_UNIT: u128 = 100_000_000;

/// Borsh widths, which are also the offsets everything else is derived from.
pub const SLOT_LEN: usize = 32 + 8 + 8 + 8 + 8 + 1;
pub const ORDER_LEN: usize = 8 + 1 + 1 + 8 + 8 + 1;

/// `8 + InitSpace`: market + leg + (4 + 32*Slot) + (4 + 128*Order) +
/// next_order_id + volume_base + bump.
pub const BOOK_LEN: usize = DISCRIMINATOR_LEN
    + 32
    + 1
    + 4
    + MAX_TRADERS * SLOT_LEN
    + 4
    + MAX_ORDERS * ORDER_LEN
    + 8
    + 8
    + 1;
/// `8 + InitSpace`: seven pubkeys, a maturity and a bump.
pub const MARKET_LEN: usize = DISCRIMINATOR_LEN + 32 * 7 + 8 + 1;

/// Which leg of a series this book trades.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

    pub fn from_tag(tag: u8) -> Result<Self, MarketError> {
        match tag {
            0 => Ok(Leg::P),
            1 => Ok(Leg::N),
            // Borsh rejects an out-of-range enum tag; so does this.
            _ => Err(MarketError::InvalidAmount),
        }
    }
}

/// One trader's escrowed balance.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Slot {
    pub owner: [u8; 32],
    pub base_free: u64,
    pub base_locked: u64,
    pub quote_free: u64,
    pub quote_locked: u64,
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
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Order {
    pub id: u64,
    /// Index into [`Book::slots`].
    pub trader: u8,
    pub is_bid: bool,
    pub price: u64,
    pub remaining: u64,
    pub active: bool,
}

/// The order book, balances included -- as a **view over the account bytes**,
/// not a value.
///
/// This is the one place the port departs from the Anchor build's shape, and it
/// is not a stylistic choice. Materialised as a struct, `Book` is 6,472 bytes:
/// 32 slots at 72 and 128 orders at 32, once Rust has padded them. Solana caps
/// a stack frame at 4,096, so returning one by value produced a binary that
/// faulted on entry with an access violation -- and `cargo build-sbf` emitted
/// it anyway, reporting the overflow on stderr while still exiting 0.
///
/// Anchor never hits this because `Box<Account<Book>>` puts the deserialised
/// book on the heap. This crate has no allocator, so instead nothing is
/// deserialised: every read and write goes straight at the account buffer, and
/// only one `Slot` or `Order` at a time is ever on the stack.
///
/// # Offsets move
///
/// Borsh writes the trailing scalars *after* both vectors, so `next_order_id`,
/// `volume_base` and `bump` sit at an offset that depends on how many slots and
/// orders exist. Appending a slot shifts the whole orders region right. That is
/// handled here rather than papered over, because the alternative -- storing at
/// fixed maximum offsets -- would no longer be the layout Anchor reads.
pub struct BookView<'a> {
    data: &'a mut [u8],
}

/// Offset of the slot-count prefix: discriminator, market, leg.
const SLOTS_LEN_AT: usize = DISCRIMINATOR_LEN + 32 + 1;
const SLOTS_AT: usize = SLOTS_LEN_AT + 4;

impl<'a> BookView<'a> {
    /// Attach to an account, checking the discriminator and both lengths.
    pub fn new(data: &'a mut [u8]) -> Result<Self, MarketError> {
        if data.len() < BOOK_LEN || data[..DISCRIMINATOR_LEN] != BOOK_DISC {
            return Err(MarketError::OrderNotFound);
        }
        let view = Self { data };
        if view.slots_len() > MAX_TRADERS {
            return Err(MarketError::NoSlot);
        }
        if view.orders_len() > MAX_ORDERS {
            return Err(MarketError::BookFull);
        }
        Ok(view)
    }

    /// Lay down a freshly opened book, exactly as `initialize_book` leaves it.
    ///
    /// `next_order_id` starts at **1**, not 0, so the first order placed
    /// carries id 1. That is the Anchor build's choice and a client may have
    /// recorded an id, so it is mirrored rather than tidied.
    pub fn initialize(
        data: &'a mut [u8],
        market: &[u8; 32],
        leg: Leg,
        bump: u8,
    ) -> Result<Self, MarketError> {
        if data.len() < BOOK_LEN {
            return Err(MarketError::MathOverflow);
        }
        for byte in data.iter_mut() {
            *byte = 0;
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&BOOK_DISC);
        data[DISCRIMINATOR_LEN..DISCRIMINATOR_LEN + 32].copy_from_slice(market);
        data[DISCRIMINATOR_LEN + 32] = leg.tag();
        let mut view = Self { data };
        view.set_slots_len(0);
        view.set_orders_len(0);
        view.set_next_order_id(1);
        view.set_volume_base(0);
        view.set_bump(bump);
        Ok(view)
    }

    fn u32_at(&self, at: usize) -> u32 {
        u32::from_le_bytes([
            self.data[at],
            self.data[at + 1],
            self.data[at + 2],
            self.data[at + 3],
        ])
    }

    fn u64_at(&self, at: usize) -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[at..at + 8]);
        u64::from_le_bytes(b)
    }

    pub fn market(&self) -> [u8; 32] {
        let mut k = [0u8; 32];
        k.copy_from_slice(&self.data[DISCRIMINATOR_LEN..DISCRIMINATOR_LEN + 32]);
        k
    }

    pub fn leg(&self) -> Result<Leg, MarketError> {
        Leg::from_tag(self.data[DISCRIMINATOR_LEN + 32])
    }

    pub fn slots_len(&self) -> usize {
        self.u32_at(SLOTS_LEN_AT) as usize
    }

    fn set_slots_len(&mut self, n: usize) {
        self.data[SLOTS_LEN_AT..SLOTS_LEN_AT + 4].copy_from_slice(&(n as u32).to_le_bytes());
    }

    /// Where the order-count prefix starts, which depends on the slot count.
    fn orders_len_at(&self) -> usize {
        SLOTS_AT + self.slots_len() * SLOT_LEN
    }

    pub fn orders_len(&self) -> usize {
        self.u32_at(self.orders_len_at()) as usize
    }

    fn set_orders_len(&mut self, n: usize) {
        let at = self.orders_len_at();
        self.data[at..at + 4].copy_from_slice(&(n as u32).to_le_bytes());
    }

    fn orders_at(&self) -> usize {
        self.orders_len_at() + 4
    }

    /// Where the trailing scalars start: after both vectors.
    fn tail_at(&self) -> usize {
        self.orders_at() + self.orders_len() * ORDER_LEN
    }

    pub fn next_order_id(&self) -> u64 {
        self.u64_at(self.tail_at())
    }

    pub fn set_next_order_id(&mut self, v: u64) {
        let at = self.tail_at();
        self.data[at..at + 8].copy_from_slice(&v.to_le_bytes());
    }

    pub fn volume_base(&self) -> u64 {
        self.u64_at(self.tail_at() + 8)
    }

    pub fn set_volume_base(&mut self, v: u64) {
        let at = self.tail_at() + 8;
        self.data[at..at + 8].copy_from_slice(&v.to_le_bytes());
    }

    pub fn bump(&self) -> u8 {
        self.data[self.tail_at() + 16]
    }

    pub fn set_bump(&mut self, v: u8) {
        let at = self.tail_at() + 16;
        self.data[at] = v;
    }

    pub fn slot(&self, i: usize) -> Slot {
        let at = SLOTS_AT + i * SLOT_LEN;
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&self.data[at..at + 32]);
        Slot {
            owner,
            base_free: self.u64_at(at + 32),
            base_locked: self.u64_at(at + 40),
            quote_free: self.u64_at(at + 48),
            quote_locked: self.u64_at(at + 56),
            occupied: self.data[at + 64] != 0,
        }
    }

    pub fn set_slot(&mut self, i: usize, s: &Slot) {
        let at = SLOTS_AT + i * SLOT_LEN;
        self.data[at..at + 32].copy_from_slice(&s.owner);
        self.data[at + 32..at + 40].copy_from_slice(&s.base_free.to_le_bytes());
        self.data[at + 40..at + 48].copy_from_slice(&s.base_locked.to_le_bytes());
        self.data[at + 48..at + 56].copy_from_slice(&s.quote_free.to_le_bytes());
        self.data[at + 56..at + 64].copy_from_slice(&s.quote_locked.to_le_bytes());
        self.data[at + 64] = s.occupied as u8;
    }

    /// Append a slot. This shifts the entire orders region and the tail right
    /// by one slot, which is the cost of keeping borsh's layout.
    pub fn push_slot(&mut self, s: &Slot) -> Result<usize, MarketError> {
        let n = self.slots_len();
        if n >= MAX_TRADERS {
            return Err(MarketError::NoSlot);
        }
        let from = self.orders_len_at();
        let to = from + SLOT_LEN;
        let tail = 4 + self.orders_len() * ORDER_LEN + 17;
        if to + tail > self.data.len() {
            return Err(MarketError::MathOverflow);
        }
        self.data.copy_within(from..from + tail, to);
        self.set_slots_len(n + 1);
        self.set_slot(n, s);
        Ok(n)
    }

    pub fn order(&self, i: usize) -> Order {
        let at = self.orders_at() + i * ORDER_LEN;
        Order {
            id: self.u64_at(at),
            trader: self.data[at + 8],
            is_bid: self.data[at + 9] != 0,
            price: self.u64_at(at + 10),
            remaining: self.u64_at(at + 18),
            active: self.data[at + 26] != 0,
        }
    }

    pub fn set_order(&mut self, i: usize, o: &Order) {
        let at = self.orders_at() + i * ORDER_LEN;
        self.data[at..at + 8].copy_from_slice(&o.id.to_le_bytes());
        self.data[at + 8] = o.trader;
        self.data[at + 9] = o.is_bid as u8;
        self.data[at + 10..at + 18].copy_from_slice(&o.price.to_le_bytes());
        self.data[at + 18..at + 26].copy_from_slice(&o.remaining.to_le_bytes());
        self.data[at + 26] = o.active as u8;
    }

    /// Append an order, shifting only the 17-byte tail.
    pub fn push_order(&mut self, o: &Order) -> Result<usize, MarketError> {
        let n = self.orders_len();
        if n >= MAX_ORDERS {
            return Err(MarketError::BookFull);
        }
        let tail = self.tail_at();
        if tail + ORDER_LEN + 17 > self.data.len() {
            return Err(MarketError::MathOverflow);
        }
        self.data.copy_within(tail..tail + 17, tail + ORDER_LEN);
        self.set_orders_len(n + 1);
        self.set_order(n, o);
        Ok(n)
    }

    /// `Vec::swap_remove`: the last order fills the hole, then the tail moves
    /// left. Spelled out because the survivor's position is visible to anyone
    /// reading the account.
    pub fn swap_remove_order(&mut self, i: usize) {
        let n = self.orders_len();
        let last = n - 1;
        let moved = self.order(last);
        self.set_order(i, &moved);
        let tail = self.tail_at();
        let dst = tail - ORDER_LEN;
        self.data.copy_within(tail..tail + 17, dst);
        self.set_orders_len(last);
    }
}

/// Immutable wiring for one series' two books. Never delegated.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Market {
    pub series: [u8; 32],
    pub p_mint: [u8; 32],
    pub n_mint: [u8; 32],
    pub quote_mint: [u8; 32],
    pub p_vault: [u8; 32],
    pub n_vault: [u8; 32],
    pub quote_vault: [u8; 32],
    pub maturity_ts: i64,
    pub bump: u8,
}

impl Market {
    pub fn base_mint(&self, leg: Leg) -> [u8; 32] {
        match leg {
            Leg::P => self.p_mint,
            Leg::N => self.n_mint,
        }
    }

    pub fn base_vault(&self, leg: Leg) -> [u8; 32] {
        match leg {
            Leg::P => self.p_vault,
            Leg::N => self.n_vault,
        }
    }
}

/// A cursor over a borsh body, so every read is bounds-checked once.
struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], MarketError> {
        let end = self.at.checked_add(n).ok_or(MarketError::MathOverflow)?;
        if end > self.data.len() {
            return Err(MarketError::MathOverflow);
        }
        let out = &self.data[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, MarketError> {
        Ok(self.take(1)?[0])
    }

    fn u64(&mut self) -> Result<u64, MarketError> {
        let b = self.take(8)?;
        let mut buf = [0u8; 8];
        buf.copy_from_slice(b);
        Ok(u64::from_le_bytes(buf))
    }

    fn i64(&mut self) -> Result<i64, MarketError> {
        Ok(self.u64()? as i64)
    }

    fn key(&mut self) -> Result<[u8; 32], MarketError> {
        let b = self.take(32)?;
        let mut buf = [0u8; 32];
        buf.copy_from_slice(b);
        Ok(buf)
    }
}

/// A cursor that writes, mirroring [`Cursor`].
struct Writer<'a> {
    data: &'a mut [u8],
    at: usize,
}

impl<'a> Writer<'a> {
    fn new(data: &'a mut [u8]) -> Self {
        Self { data, at: 0 }
    }

    fn put(&mut self, bytes: &[u8]) -> Result<(), MarketError> {
        let end = self
            .at
            .checked_add(bytes.len())
            .ok_or(MarketError::MathOverflow)?;
        if end > self.data.len() {
            return Err(MarketError::MathOverflow);
        }
        self.data[self.at..end].copy_from_slice(bytes);
        self.at = end;
        Ok(())
    }
}

fn strip<'a>(data: &'a [u8], disc: &[u8; 8]) -> Result<&'a [u8], MarketError> {
    if data.len() < DISCRIMINATOR_LEN || &data[..DISCRIMINATOR_LEN] != disc {
        return Err(MarketError::OrderNotFound);
    }
    Ok(&data[DISCRIMINATOR_LEN..])
}

/// Read the fields that identify a book, without attaching a mutable view.
///
/// `deposit`, `withdraw` and the trading instructions have to check
/// `has_one = market` and the seeds *before* taking the mutable borrow the
/// engine needs, so those three fields are read here from a shared borrow.
pub fn book_header(data: &[u8]) -> Result<([u8; 32], Leg, u8), MarketError> {
    if data.len() < BOOK_LEN || data[..DISCRIMINATOR_LEN] != BOOK_DISC {
        return Err(MarketError::OrderNotFound);
    }
    let mut market = [0u8; 32];
    market.copy_from_slice(&data[DISCRIMINATOR_LEN..DISCRIMINATOR_LEN + 32]);
    let leg = Leg::from_tag(data[DISCRIMINATOR_LEN + 32])?;

    let slots_at = DISCRIMINATOR_LEN + 32 + 1;
    let slots_len = u32::from_le_bytes([
        data[slots_at],
        data[slots_at + 1],
        data[slots_at + 2],
        data[slots_at + 3],
    ]) as usize;
    if slots_len > MAX_TRADERS {
        return Err(MarketError::NoSlot);
    }
    let orders_len_at = slots_at + 4 + slots_len * SLOT_LEN;
    let orders_len = u32::from_le_bytes([
        data[orders_len_at],
        data[orders_len_at + 1],
        data[orders_len_at + 2],
        data[orders_len_at + 3],
    ]) as usize;
    if orders_len > MAX_ORDERS {
        return Err(MarketError::BookFull);
    }
    // The trailing scalars sit after both vectors; the bump is the last byte.
    let tail = orders_len_at + 4 + orders_len * ORDER_LEN;
    Ok((market, leg, data[tail + 16]))
}

impl Market {
    pub fn load(data: &[u8]) -> Result<Self, MarketError> {
        let body = strip(data, &MARKET_DISC)?;
        let mut c = Cursor::new(body);
        Ok(Self {
            series: c.key()?,
            p_mint: c.key()?,
            n_mint: c.key()?,
            quote_mint: c.key()?,
            p_vault: c.key()?,
            n_vault: c.key()?,
            quote_vault: c.key()?,
            maturity_ts: c.i64()?,
            bump: c.u8()?,
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), MarketError> {
        if data.len() < MARKET_LEN {
            return Err(MarketError::MathOverflow);
        }
        data[..DISCRIMINATOR_LEN].copy_from_slice(&MARKET_DISC);
        let mut w = Writer::new(&mut data[DISCRIMINATOR_LEN..]);
        for k in [
            &self.series,
            &self.p_mint,
            &self.n_mint,
            &self.quote_mint,
            &self.p_vault,
            &self.n_vault,
            &self.quote_vault,
        ] {
            w.put(k)?;
        }
        w.put(&self.maturity_ts.to_le_bytes())?;
        w.put(&[self.bump])?;
        Ok(())
    }
}
