// SPDX-License-Identifier: Apache-2.0
//! Anchor-compatible events.
//!
//! `emit!` compiles to `sol_log_data(&[&Event::data(&e)])`, where `data()` is
//! `sha256("event:<Name>")[..8]` followed by the borsh body. The runtime
//! base64-encodes that into a `Program data:` line, which is what every client
//! event parser reads -- so reproducing the bytes exactly is what keeps a
//! listener built against the Anchor IDL working against this build.
//!
//! All five bodies are fixed width, so each is assembled in a stack array.

pub const DEPOSITED_DISC: [u8; 8] = [111, 141, 26, 45, 161, 35, 100, 57];
pub const WITHDRAWN_DISC: [u8; 8] = [20, 89, 223, 198, 194, 124, 219, 13];
pub const ORDER_PLACED_DISC: [u8; 8] = [96, 130, 204, 234, 169, 219, 216, 227];
pub const ORDER_CANCELLED_DISC: [u8; 8] = [108, 56, 128, 68, 168, 113, 168, 239];
pub const ORDER_FILLED_DISC: [u8; 8] = [120, 124, 109, 66, 249, 116, 174, 30];

/// `sol_log_data` takes an array of slice descriptors and a count. A `&[&[u8]]`
/// already has that layout, so one is passed straight through -- the same
/// single-slice shape `emit!` produces.
#[inline]
fn log_data(payload: &[u8]) {
    #[cfg(target_os = "solana")]
    {
        let slices: [&[u8]; 1] = [payload];
        unsafe {
            pinocchio::syscalls::sol_log_data(slices.as_ptr() as *const u8, slices.len() as u64);
        }
    }
    #[cfg(not(target_os = "solana"))]
    let _ = payload;
}

/// A stack writer, so nothing here allocates.
struct Body<const N: usize> {
    bytes: [u8; N],
    at: usize,
}

impl<const N: usize> Body<N> {
    fn new(disc: &[u8; 8]) -> Self {
        let mut b = Self {
            bytes: [0u8; N],
            at: 0,
        };
        b.put(disc);
        b
    }

    fn put(&mut self, src: &[u8]) {
        let end = self.at + src.len();
        self.bytes[self.at..end].copy_from_slice(src);
        self.at = end;
    }

    fn emit(&self) {
        log_data(&self.bytes[..self.at]);
    }
}

/// `Deposited` and `Withdrawn` share a body: book, trader, base, quote.
const TRANSFER_EVENT_LEN: usize = 8 + 32 + 32 + 8 + 8;

fn transfer_event(
    disc: &[u8; 8],
    book: &[u8; 32],
    trader: &[u8; 32],
    base_amount: u64,
    quote_amount: u64,
) {
    let mut b = Body::<TRANSFER_EVENT_LEN>::new(disc);
    b.put(book);
    b.put(trader);
    b.put(&base_amount.to_le_bytes());
    b.put(&quote_amount.to_le_bytes());
    b.emit();
}

pub fn deposited(book: &[u8; 32], trader: &[u8; 32], base_amount: u64, quote_amount: u64) {
    transfer_event(&DEPOSITED_DISC, book, trader, base_amount, quote_amount);
}

pub fn withdrawn(book: &[u8; 32], trader: &[u8; 32], base_amount: u64, quote_amount: u64) {
    transfer_event(&WITHDRAWN_DISC, book, trader, base_amount, quote_amount);
}

/// `OrderPlaced`: book, trader, id, is_bid, price, qty.
pub const ORDER_PLACED_LEN: usize = 8 + 32 + 32 + 8 + 1 + 8 + 8;

pub fn order_placed(
    book: &[u8; 32],
    trader: &[u8; 32],
    id: u64,
    is_bid: bool,
    price: u64,
    qty: u64,
) {
    let mut b = Body::<ORDER_PLACED_LEN>::new(&ORDER_PLACED_DISC);
    b.put(book);
    b.put(trader);
    b.put(&id.to_le_bytes());
    b.put(&[is_bid as u8]);
    b.put(&price.to_le_bytes());
    b.put(&qty.to_le_bytes());
    b.emit();
}

/// `OrderCancelled`: book, trader, id.
pub const ORDER_CANCELLED_LEN: usize = 8 + 32 + 32 + 8;

pub fn order_cancelled(book: &[u8; 32], trader: &[u8; 32], id: u64) {
    let mut b = Body::<ORDER_CANCELLED_LEN>::new(&ORDER_CANCELLED_DISC);
    b.put(book);
    b.put(trader);
    b.put(&id.to_le_bytes());
    b.emit();
}

/// `OrderFilled`: book, taker, id, filled.
pub const ORDER_FILLED_LEN: usize = 8 + 32 + 32 + 8 + 8;

pub fn order_filled(book: &[u8; 32], taker: &[u8; 32], id: u64, filled: u64) {
    let mut b = Body::<ORDER_FILLED_LEN>::new(&ORDER_FILLED_DISC);
    b.put(book);
    b.put(taker);
    b.put(&id.to_le_bytes());
    b.put(&filled.to_le_bytes());
    b.emit();
}
