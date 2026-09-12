// SPDX-License-Identifier: Apache-2.0
//! The two matching engines, driven through identical operation sequences.
//!
//! This links **both crates** and runs every `place` / `cancel` / `fill` against
//! both, comparing the *whole book* after each step -- slots, orders, order ids,
//! volume -- and the error code when they reject. An engine that agreed on the
//! happy path and diverged on which order `swap_remove` left where would be a
//! silent corruption of the account, so the comparison is on state rather than
//! on return values.
//!
//! Nothing here is transcribed. Discriminators are derived from their
//! preimages, layouts from Anchor's own `InitSpace`, error codes from
//! `market::logic::MarketError` itself.

use {
    anchor_lang::{prelude::*, Discriminator, Space},
    market::{
        logic::MarketError as AnchorErr,
        state::{Book as AnchorBook, Leg as AnchorLeg, Order as AnchorOrder, Slot as AnchorSlot},
    },
    market_pinocchio::{
        error::MarketError as PinErr,
        ix, logic as pin_logic,
        state::{self as pin_state, BookView, Leg as PinLeg},
    },
    proptest::prelude::*,
    sha2::{Digest, Sha256},
};

fn disc(preimage: &str) -> [u8; 8] {
    let h = Sha256::digest(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

fn anchor_code(e: &anchor_lang::error::Error) -> u32 {
    match e {
        anchor_lang::error::Error::AnchorError(ae) => ae.error_code_number,
        other => panic!("expected an AnchorError, got {other:?}"),
    }
}

fn pin_code(e: PinErr) -> u32 {
    match pinocchio::error::ProgramError::from(e) {
        pinocchio::error::ProgramError::Custom(c) => c,
        other => panic!("expected Custom, got {other:?}"),
    }
}

// --- Identity and layout --------------------------------------------------

#[test]
fn program_id_matches_the_anchor_variant() {
    assert_eq!(market_pinocchio::ID, market::ID.to_bytes());
}

#[test]
fn instruction_discriminators_match_anchor() {
    let cases = [
        ("global:initialize_market", ix::INITIALIZE_MARKET),
        ("global:initialize_book", ix::INITIALIZE_BOOK),
        ("global:deposit", ix::DEPOSIT),
        ("global:withdraw", ix::WITHDRAW),
        ("global:place_order", ix::PLACE_ORDER),
        ("global:cancel_order", ix::CANCEL_ORDER),
        ("global:fill_order", ix::FILL_ORDER),
        ("global:delegate_book", ix::DELEGATE_BOOK),
        ("global:commit_book", ix::COMMIT_BOOK),
        ("global:undelegate_book", ix::UNDELEGATE_BOOK),
        ("global:process_undelegation", ix::PROCESS_UNDELEGATION),
    ];
    for (preimage, actual) in cases {
        assert_eq!(disc(preimage), actual, "{preimage}");
    }
}

#[test]
fn account_discriminators_match_anchor() {
    assert_eq!(pin_state::BOOK_DISC, market::state::Book::DISCRIMINATOR);
    assert_eq!(pin_state::MARKET_DISC, market::state::Market::DISCRIMINATOR);
}

#[test]
fn account_lengths_match_anchor() {
    assert_eq!(pin_state::BOOK_LEN, 8 + market::state::Book::INIT_SPACE);
    assert_eq!(pin_state::MARKET_LEN, 8 + market::state::Market::INIT_SPACE);
}

#[test]
fn capacities_and_units_match_anchor() {
    assert_eq!(pin_state::MAX_TRADERS, market::state::MAX_TRADERS);
    assert_eq!(pin_state::MAX_ORDERS, market::state::MAX_ORDERS);
    assert_eq!(pin_state::BASE_UNIT, market::state::BASE_UNIT);
    assert_eq!(pin_state::MARKET_SEED, market::MARKET_SEED);
    assert_eq!(pin_state::BOOK_SEED, market::BOOK_SEED);
}

#[test]
fn error_codes_match_the_anchor_variant() {
    let cases = [
        (PinErr::InvalidAmount, AnchorErr::InvalidAmount),
        (PinErr::InvalidPrice, AnchorErr::InvalidPrice),
        (PinErr::BookFull, AnchorErr::BookFull),
        (PinErr::NoSlot, AnchorErr::NoSlot),
        (PinErr::UnknownTrader, AnchorErr::UnknownTrader),
        (PinErr::InsufficientBalance, AnchorErr::InsufficientBalance),
        (PinErr::OrderNotFound, AnchorErr::OrderNotFound),
        (PinErr::NotOrderOwner, AnchorErr::NotOrderOwner),
        (PinErr::SelfFill, AnchorErr::SelfFill),
        (PinErr::MathOverflow, AnchorErr::MathOverflow),
        (PinErr::MarketClosed, AnchorErr::MarketClosed),
    ];
    for (pin, anchor) in cases {
        assert_eq!(pin_code(pin), anchor as u32 + 6000, "{pin:?}");
    }
}

#[test]
fn the_leg_tag_matches_anchor() {
    assert_eq!(PinLeg::P.tag(), AnchorLeg::P.tag());
    assert_eq!(PinLeg::N.tag(), AnchorLeg::N.tag());
}

// --- Book serialisation ---------------------------------------------------

fn new_anchor_book(market: Pubkey, bump: u8) -> AnchorBook {
    AnchorBook {
        market,
        leg: AnchorLeg::N,
        slots: vec![],
        orders: vec![],
        // Mirrors `initialize_book`, which starts ids at 1.
        next_order_id: 1,
        volume_base: 0,
        bump,
    }
}

/// The Pinocchio side is the account bytes themselves. A view is attached for
/// each operation and dropped again, which is exactly how the program uses it
/// -- and why nothing here puts a 6 KB book on the stack.
fn new_pin_book(market: [u8; 32], bump: u8) -> Vec<u8> {
    let mut buf = vec![0u8; pin_state::BOOK_LEN];
    BookView::initialize(&mut buf, &market, PinLeg::N, bump).unwrap();
    buf
}

fn view(buf: &mut [u8]) -> BookView<'_> {
    BookView::new(buf).unwrap()
}

/// Anchor writes `8 + borsh`, and pads the rest of the account with zeros. A
/// book written by this build has to deserialise under Anchor with every field
/// intact -- including the variable-length vectors, which is the part the fixed
/// arrays here could plausibly get wrong.
fn assert_serialises_identically(pin: &mut [u8], anchor: &AnchorBook) {
    let mine = pin.to_vec();

    let parsed = AnchorBook::try_deserialize(&mut mine.as_slice()).unwrap();
    assert_eq!(parsed.market, anchor.market);
    assert_eq!(parsed.leg.tag(), anchor.leg.tag());
    assert_eq!(parsed.next_order_id, anchor.next_order_id);
    assert_eq!(parsed.volume_base, anchor.volume_base);
    assert_eq!(parsed.bump, anchor.bump);
    assert_eq!(parsed.slots.len(), anchor.slots.len());
    assert_eq!(parsed.orders.len(), anchor.orders.len());
    for (a, b) in parsed.slots.iter().zip(anchor.slots.iter()) {
        assert_slot_eq(a, b);
    }
    for (a, b) in parsed.orders.iter().zip(anchor.orders.iter()) {
        assert_order_eq(a, b);
    }

    // ...and round-trips back through this build unchanged.
    let mut back = mine.clone();
    assert_book_eq(&view(&mut back), anchor);
}

fn assert_slot_eq(a: &AnchorSlot, b: &AnchorSlot) {
    assert_eq!(a.owner, b.owner);
    assert_eq!(a.base_free, b.base_free);
    assert_eq!(a.base_locked, b.base_locked);
    assert_eq!(a.quote_free, b.quote_free);
    assert_eq!(a.quote_locked, b.quote_locked);
    assert_eq!(a.occupied, b.occupied);
}

fn assert_order_eq(a: &AnchorOrder, b: &AnchorOrder) {
    assert_eq!(a.id, b.id);
    assert_eq!(a.trader, b.trader);
    assert_eq!(a.is_bid, b.is_bid);
    assert_eq!(a.price, b.price);
    assert_eq!(a.remaining, b.remaining);
    assert_eq!(a.active, b.active);
}

/// The whole book, compared field for field. Order *position* matters: it is
/// what `swap_remove` decides, and a client reading the account sees it.
fn assert_book_eq(pin: &BookView<'_>, anchor: &AnchorBook) {
    assert_eq!(pin.market(), anchor.market.to_bytes(), "market");
    assert_eq!(pin.leg().unwrap().tag(), anchor.leg.tag(), "leg");
    assert_eq!(pin.next_order_id(), anchor.next_order_id, "next_order_id");
    assert_eq!(pin.volume_base(), anchor.volume_base, "volume_base");
    assert_eq!(pin.bump(), anchor.bump, "bump");

    assert_eq!(pin.slots_len(), anchor.slots.len(), "slot count");
    for (i, a) in anchor.slots.iter().enumerate() {
        let p = pin.slot(i);
        assert_eq!(p.owner, a.owner.to_bytes(), "slot {i} owner");
        assert_eq!(p.base_free, a.base_free, "slot {i} base_free");
        assert_eq!(p.base_locked, a.base_locked, "slot {i} base_locked");
        assert_eq!(p.quote_free, a.quote_free, "slot {i} quote_free");
        assert_eq!(p.quote_locked, a.quote_locked, "slot {i} quote_locked");
        assert_eq!(p.occupied, a.occupied, "slot {i} occupied");
    }

    assert_eq!(pin.orders_len(), anchor.orders.len(), "order count");
    for (i, a) in anchor.orders.iter().enumerate() {
        let p = pin.order(i);
        assert_eq!(p.id, a.id, "order {i} id");
        assert_eq!(p.trader, a.trader, "order {i} trader");
        assert_eq!(p.is_bid, a.is_bid, "order {i} is_bid");
        assert_eq!(p.price, a.price, "order {i} price");
        assert_eq!(p.remaining, a.remaining, "order {i} remaining");
        assert_eq!(p.active, a.active, "order {i} active");
    }
}

// --- quote_cost -----------------------------------------------------------

proptest! {
    /// The rounding rule is the one piece of arithmetic the whole book leans
    /// on: it decides how much a bid locks, and a disagreement of one atomic
    /// unit would let a partial fill leave a slot short.
    #[test]
    fn quote_cost_agrees(price in any::<u64>(), qty in any::<u64>()) {
        let a = market::logic::quote_cost(price, qty);
        let b = pin_logic::quote_cost(price, qty);
        match (a, b) {
            (Ok(x), Ok(y)) => prop_assert_eq!(x, y),
            (Err(x), Err(y)) => prop_assert_eq!(anchor_code(&x), pin_code(y)),
            (x, y) => panic!("disagreement at price={price} qty={qty}: {x:?} vs {y:?}"),
        }
    }

    #[test]
    fn require_open_at_agrees(maturity in any::<i64>(), now in any::<i64>()) {
        let a = market::logic::require_open_at(maturity, now);
        let b = pin_logic::require_open_at(maturity, now);
        prop_assert_eq!(a.is_ok(), b.is_ok());
        if let (Err(x), Err(y)) = (a, b) {
            prop_assert_eq!(anchor_code(&x), pin_code(y));
        }
    }
}

// --- The engine, differentially -------------------------------------------

/// One operation in a generated sequence.
#[derive(Clone, Copy, Debug)]
enum Op {
    Credit {
        trader: u8,
        base: u64,
        quote: u64,
    },
    Place {
        trader: u8,
        is_bid: bool,
        price: u64,
        qty: u64,
    },
    Cancel {
        trader: u8,
        id: u64,
    },
    Fill {
        trader: u8,
        id: u64,
        qty: u64,
    },
    Release {
        slot: u8,
    },
}

/// A small fixed cast of traders, so collisions and self-fills actually happen.
fn trader_key(i: u8) -> [u8; 32] {
    let mut k = [0u8; 32];
    k[0] = i;
    k
}

/// Credit a slot directly, standing in for `deposit` -- which is an L1 token
/// transfer, not part of the engine.
fn credit(buf: &mut [u8], anchor: &mut AnchorBook, trader: u8, base: u64, quote: u64) {
    let mut pin = view(buf);
    let key = trader_key(trader);
    let pk = Pubkey::new_from_array(key);
    let (pi, ai) = match (pin.slot_for(&key), anchor.slot_for(&pk)) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(_), Err(_)) => return, // both full
        (a, b) => panic!("slot_for disagreed: {a:?} vs {b:?}"),
    };
    assert_eq!(pi, ai, "slot_for returned different indices");
    let mut slot = pin.slot(pi);
    slot.base_free = slot.base_free.saturating_add(base);
    slot.quote_free = slot.quote_free.saturating_add(quote);
    pin.set_slot(pi, &slot);
    anchor.slots[ai].base_free = anchor.slots[ai].base_free.saturating_add(base);
    anchor.slots[ai].quote_free = anchor.slots[ai].quote_free.saturating_add(quote);
}

fn apply(buf: &mut [u8], anchor: &mut AnchorBook, op: Op) {
    match op {
        Op::Credit {
            trader,
            base,
            quote,
        } => credit(buf, anchor, trader, base, quote),
        Op::Place {
            trader,
            is_bid,
            price,
            qty,
        } => {
            let key = trader_key(trader);
            let a = anchor.place(&Pubkey::new_from_array(key), is_bid, price, qty);
            let b = view(buf).place(&key, is_bid, price, qty);
            match (a, b) {
                (Ok(x), Ok(y)) => assert_eq!(x, y, "place returned different ids"),
                (Err(x), Err(y)) => {
                    assert_eq!(anchor_code(&x), pin_code(y), "place rejected differently")
                }
                (x, y) => panic!("place disagreed: {x:?} vs {y:?}"),
            }
        }
        Op::Cancel { trader, id } => {
            let key = trader_key(trader);
            let a = anchor.cancel(&Pubkey::new_from_array(key), id);
            let b = view(buf).cancel(&key, id);
            match (a, b) {
                (Ok(()), Ok(())) => {}
                (Err(x), Err(y)) => {
                    assert_eq!(anchor_code(&x), pin_code(y), "cancel rejected differently")
                }
                (x, y) => panic!("cancel disagreed: {x:?} vs {y:?}"),
            }
        }
        Op::Fill { trader, id, qty } => {
            let key = trader_key(trader);
            let a = anchor.fill(&Pubkey::new_from_array(key), id, qty);
            let b = view(buf).fill(&key, id, qty);
            match (a, b) {
                (Ok(x), Ok(y)) => assert_eq!(x, y, "fill returned different amounts"),
                (Err(x), Err(y)) => {
                    assert_eq!(anchor_code(&x), pin_code(y), "fill rejected differently")
                }
                (x, y) => panic!("fill disagreed: {x:?} vs {y:?}"),
            }
        }
        Op::Release { slot } => {
            let i = slot as usize;
            if i < view(buf).slots_len() && i < anchor.slots.len() {
                view(buf).release_if_empty(i);
                anchor.release_if_empty(i);
            }
        }
    }
    let pin = view(buf);
    assert_book_eq(&pin, anchor);
    assert_eq!(pin.totals(), anchor.totals(), "totals diverged");
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u8..6, 0u64..1_000_000_000, 0u64..1_000_000_000).prop_map(|(trader, base, quote)| {
            Op::Credit {
                trader,
                base,
                quote,
            }
        }),
        (
            0u8..6,
            any::<bool>(),
            0u64..3_000_000_000,
            0u64..500_000_000
        )
            .prop_map(|(trader, is_bid, price, qty)| Op::Place {
                trader,
                is_bid,
                price,
                qty
            }),
        (0u8..6, 0u64..12).prop_map(|(trader, id)| Op::Cancel { trader, id }),
        (0u8..6, 0u64..12, 0u64..500_000_000).prop_map(|(trader, id, qty)| Op::Fill {
            trader,
            id,
            qty
        }),
        (0u8..6).prop_map(|slot| Op::Release { slot }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    /// Arbitrary operation sequences. After every single step the two books
    /// must be identical -- not merely consistent.
    #[test]
    fn the_engines_never_diverge(ops in prop::collection::vec(op_strategy(), 1..60)) {
        let market = Pubkey::new_unique();
        let mut anchor = new_anchor_book(market, 253);
        let mut pin = new_pin_book(market.to_bytes(), 253);
        for op in ops {
            apply(&mut pin, &mut anchor, op);
        }
        assert_serialises_identically(&mut pin, &anchor);
    }
}

/// A deliberate, readable trade rather than a generated one: two traders, a
/// resting ask, a partial fill and then the rest.
#[test]
fn a_partial_fill_then_the_remainder_agrees() {
    let market = Pubkey::new_unique();
    let mut anchor = new_anchor_book(market, 250);
    let mut pin = new_pin_book(market.to_bytes(), 250);

    apply(
        &mut pin,
        &mut anchor,
        Op::Credit {
            trader: 0,
            base: 500_000_000,
            quote: 0,
        },
    );
    apply(
        &mut pin,
        &mut anchor,
        Op::Credit {
            trader: 1,
            base: 0,
            quote: 900_000_000,
        },
    );
    // Maker rests an ask: 4 whole units at $15.
    apply(
        &mut pin,
        &mut anchor,
        Op::Place {
            trader: 0,
            is_bid: false,
            price: 15_000_000,
            qty: 400_000_000,
        },
    );
    // Taker lifts a quarter of it, then the rest. A freshly opened book starts
    // `next_order_id` at 1, so the first order placed carries id 1.
    apply(
        &mut pin,
        &mut anchor,
        Op::Fill {
            trader: 1,
            id: 1,
            qty: 100_000_000,
        },
    );
    apply(
        &mut pin,
        &mut anchor,
        Op::Fill {
            trader: 1,
            id: 1,
            qty: 300_000_000,
        },
    );

    assert_eq!(
        view(&mut pin).orders_len(),
        0,
        "a fully filled order leaves the book"
    );
    assert_eq!(view(&mut pin).volume_base(), 400_000_000);
    assert_serialises_identically(&mut pin, &anchor);
}

/// `swap_remove` is the subtle one: cancelling from the middle moves the last
/// order into the hole, and both builds have to pick the same survivor order.
#[test]
fn cancelling_from_the_middle_leaves_the_same_order() {
    let market = Pubkey::new_unique();
    let mut anchor = new_anchor_book(market, 249);
    let mut pin = new_pin_book(market.to_bytes(), 249);

    apply(
        &mut pin,
        &mut anchor,
        Op::Credit {
            trader: 0,
            base: 900_000_000,
            quote: 0,
        },
    );
    for _ in 0..3 {
        apply(
            &mut pin,
            &mut anchor,
            Op::Place {
                trader: 0,
                is_bid: false,
                price: 10_000_000,
                qty: 100_000_000,
            },
        );
    }
    // Ids are 1, 2, 3. Drop the middle one; the last must take its place.
    apply(&mut pin, &mut anchor, Op::Cancel { trader: 0, id: 2 });
    assert_eq!(view(&mut pin).orders_len(), 2);
    assert_eq!(
        view(&mut pin).order(1).id,
        3,
        "the last order filled the hole"
    );
    assert_serialises_identically(&mut pin, &anchor);
}

#[test]
fn a_book_written_here_is_readable_by_anchor_when_empty() {
    let market = Pubkey::new_unique();
    let anchor = new_anchor_book(market, 255);
    let mut pin = new_pin_book(market.to_bytes(), 255);
    assert_serialises_identically(&mut pin, &anchor);
}

#[test]
fn every_truncation_of_a_book_is_rejected() {
    let market = Pubkey::new_unique();
    let mut buf = new_pin_book(market.to_bytes(), 255);

    // The view requires the whole account, not just the borsh body an empty
    // book happens to occupy. That is stricter than the Anchor build, which
    // stops reading once the vectors are consumed -- and it is the right
    // constraint here, because appending a slot shifts the orders region
    // rightward into space that must already exist. A short account would
    // corrupt rather than fail.
    for n in 0..pin_state::BOOK_LEN {
        assert!(
            BookView::new(&mut buf.clone()[..n]).is_err(),
            "truncation to {n} accepted"
        );
    }
    assert!(BookView::new(&mut buf).is_ok(), "the full account reads");
}

#[test]
fn a_foreign_discriminator_is_rejected() {
    let market = Pubkey::new_unique();
    let mut buf = new_pin_book(market.to_bytes(), 255);
    for byte in 0..8 {
        for bit in 0..8 {
            let mut bad = buf.clone();
            bad[byte] ^= 1 << bit;
            assert!(
                BookView::new(&mut bad).is_err(),
                "flip {byte}:{bit} accepted"
            );
        }
    }
}

proptest! {
    /// Arbitrary bytes must never panic the loader.
    #[test]
    fn arbitrary_bytes_never_panic_the_loader(
        bytes in prop::collection::vec(any::<u8>(), 0..7000)
    ) {
        let mut b = bytes.clone();
        let _ = BookView::new(&mut b);
        let _ = market_pinocchio::state::Market::load(&bytes);
    }
}
