// SPDX-License-Identifier: Apache-2.0
//! The instruction layer: dispatch, the checks Anchor would have generated, and
//! the eleven handlers.
//!
//! # What Anchor was doing here
//!
//! Every `#[account(...)]` attribute in `programs/market/src/lib.rs` is a check
//! that no longer exists unless it is written below. The ones that carry the
//! most weight in this program:
//!
//! - `has_one = market` on `book`, which is what stops a book from one market
//!   being presented against another's vaults.
//! - `constraint = base_vault.key() == market.base_vault(book.leg)`, which
//!   binds the base vault to the leg the book actually trades. Without it a
//!   trader could deposit N and be credited against the P book.
//! - `token::authority = trader` on `trader_base` / `trader_quote` in
//!   `deposit`, so a caller cannot fund their slot out of somebody else's
//!   token account.
//! - `Account<'info, Book>` itself on `deposit` and `withdraw`. While the book
//!   is delegated it is owned by the delegation program, so the owner check
//!   fails and neither instruction can run -- which is what keeps the rollup's
//!   view of a balance and the vault's contents from diverging. That property
//!   is free in Anchor and is [`accounts::owned_by_program`] here.

use {
    crate::{
        delegation::{self, Intent},
        error::MarketError,
        events,
        logic::require_open_at,
        state::{BookView, Leg, Market, BOOK_LEN, BOOK_SEED, MARKET_LEN, MARKET_SEED},
        token,
    },
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::{invoke, invoke_signed, Seed, Signer},
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
        sysvars::{clock::Clock, Sysvar},
        ProgramResult,
    },
};

/// Lamports per byte for a rent-exempt account, and the runtime's per-account
/// storage overhead on top of the data.
const LAMPORTS_PER_BYTE: u64 = 6960;
const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

fn rent_exempt(len: usize) -> u64 {
    (ACCOUNT_STORAGE_OVERHEAD + len as u64) * LAMPORTS_PER_BYTE
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 8 {
        return Err(MarketError::InvalidAmount.into());
    }
    let (disc, args) = data.split_at(8);
    let disc: [u8; 8] = disc.try_into().map_err(|_| ProgramError::InvalidArgument)?;

    match disc {
        crate::ix::INITIALIZE_MARKET => initialize_market(program_id, accounts, args),
        crate::ix::INITIALIZE_BOOK => initialize_book(program_id, accounts, args),
        crate::ix::DEPOSIT => deposit(program_id, accounts, args),
        crate::ix::WITHDRAW => withdraw(program_id, accounts, args),
        crate::ix::PLACE_ORDER => place_order(program_id, accounts, args),
        crate::ix::CANCEL_ORDER => cancel_order(program_id, accounts, args),
        crate::ix::FILL_ORDER => fill_order(program_id, accounts, args),
        crate::ix::DELEGATE_BOOK => delegate_book(program_id, accounts, args),
        crate::ix::COMMIT_BOOK => schedule(program_id, accounts, Intent::Commit),
        crate::ix::UNDELEGATE_BOOK => schedule(program_id, accounts, Intent::CommitAndUndelegate),
        crate::ix::PROCESS_UNDELEGATION => process_undelegation(program_id, accounts, args),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The checks Anchor would have generated.
pub mod accounts {
    use super::*;

    pub fn owned_by_program(
        account: &AccountView,
        program_id: &Address,
    ) -> Result<(), ProgramError> {
        if account.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        Ok(())
    }

    pub fn signer(account: &AccountView) -> Result<(), ProgramError> {
        if !account.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        Ok(())
    }

    pub fn writable(account: &AccountView) -> Result<(), ProgramError> {
        if !account.is_writable() {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }

    pub fn key_is(account: &AccountView, expected: &[u8; 32]) -> Result<(), ProgramError> {
        if account.address().as_array() != expected {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }

    /// `seeds = [..], bump = <stored>`, re-derived with the stored bump the way
    /// Anchor does rather than searched for.
    pub fn pda_with_bump(
        account: &AccountView,
        seeds: &[&[u8]],
        bump: u8,
        program_id: &Address,
    ) -> Result<(), ProgramError> {
        let mut full: [&[u8]; 4] = [&[], &[], &[], &[]];
        if seeds.len() + 1 > full.len() {
            return Err(ProgramError::InvalidArgument);
        }
        for (slot, seed) in full.iter_mut().zip(seeds.iter()) {
            *slot = seed;
        }
        let bump_arr = [bump];
        full[seeds.len()] = &bump_arr;
        let expected = Address::create_program_address(&full[..seeds.len() + 1], program_id)
            .map_err(|_| ProgramError::InvalidSeeds)?;
        if account.address() != &expected {
            return Err(ProgramError::InvalidSeeds);
        }
        Ok(())
    }

    /// An SPL token account, and the fields the constraints read from it.
    /// Layout: mint(32) owner(32) amount(8) ...
    pub const TOKEN_ACCOUNT_LEN: usize = 165;

    pub fn token_account_mint(account: &AccountView) -> Result<[u8; 32], ProgramError> {
        let data = account.try_borrow()?;
        if account.owner().as_array() != &token::TOKEN_PROGRAM_ID || data.len() < TOKEN_ACCOUNT_LEN
        {
            return Err(ProgramError::IllegalOwner);
        }
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&data[..32]);
        Ok(mint)
    }

    pub fn token_account_owner(account: &AccountView) -> Result<[u8; 32], ProgramError> {
        let data = account.try_borrow()?;
        if account.owner().as_array() != &token::TOKEN_PROGRAM_ID || data.len() < TOKEN_ACCOUNT_LEN
        {
            return Err(ProgramError::IllegalOwner);
        }
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&data[32..64]);
        Ok(owner)
    }

    /// `token::authority = x` and `token::mint = y`.
    pub fn token_account_is(
        account: &AccountView,
        authority: Option<&[u8; 32]>,
        mint: &[u8; 32],
    ) -> Result<(), ProgramError> {
        if &token_account_mint(account)? != mint {
            return Err(MarketError::InvalidAmount.into());
        }
        if let Some(a) = authority {
            if &token_account_owner(account)? != a {
                return Err(MarketError::InvalidAmount.into());
            }
        }
        Ok(())
    }
}

/// Load the market, checking the seeds it stores its own bump for.
fn load_market(program_id: &Address, market: &AccountView) -> Result<Market, ProgramError> {
    accounts::owned_by_program(market, program_id)?;
    let state = {
        let data = market.try_borrow()?;
        Market::load(&data)?
    };
    accounts::pda_with_bump(
        market,
        &[MARKET_SEED, &state.series],
        state.bump,
        program_id,
    )?;
    Ok(state)
}

/// Enforce `has_one = market` and the book's own seeds.
///
/// Runs off a shared borrow and returns the leg, so the caller can take the
/// mutable borrow the engine needs afterwards rather than holding both.
fn check_book(
    program_id: &Address,
    book: &AccountView,
    market: &AccountView,
) -> Result<Leg, ProgramError> {
    accounts::owned_by_program(book, program_id)?;
    let (book_market, leg, bump) = {
        let data = book.try_borrow()?;
        crate::state::book_header(&data)?
    };
    if &book_market != market.address().as_array() {
        return Err(MarketError::UnknownTrader.into());
    }
    accounts::pda_with_bump(
        book,
        &[BOOK_SEED, market.address().as_array(), &[leg.tag()]],
        bump,
        program_id,
    )?;
    Ok(leg)
}

/// Trading stops at maturity.
fn require_open(market: &Market) -> Result<(), ProgramError> {
    Ok(require_open_at(
        market.maturity_ts,
        Clock::get()?.unix_timestamp,
    )?)
}

fn create_pda(
    payer: &AccountView,
    target: &AccountView,
    seeds: &[Seed],
    len: usize,
    program_id: &Address,
) -> ProgramResult {
    pinocchio_system::instructions::CreateAccount {
        from: payer,
        to: target,
        lamports: rent_exempt(len),
        space: len as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(seeds)])
}

fn read_i64(args: &[u8], at: usize) -> Result<i64, ProgramError> {
    if args.len() < at + 8 {
        return Err(MarketError::InvalidAmount.into());
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&args[at..at + 8]);
    Ok(i64::from_le_bytes(b))
}

fn read_u64(args: &[u8], at: usize) -> Result<u64, ProgramError> {
    Ok(read_i64(args, at)? as u64)
}

fn initialize_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> ProgramResult {
    let [payer, series, market, p_mint, n_mint, quote_mint, p_vault, n_vault, quote_vault, token_program, associated_token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let maturity_ts = read_i64(args, 0)?;
    require_open_at(maturity_ts, Clock::get()?.unix_timestamp)?;

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::writable(market)?;
    accounts::key_is(token_program, &token::TOKEN_PROGRAM_ID)?;
    accounts::key_is(
        associated_token_program,
        &token::ASSOCIATED_TOKEN_PROGRAM_ID,
    )?;
    // `init` implies `mut`; the ATA program would reject a read-only target,
    // but the Anchor build refuses before getting that far.
    for v in [&*p_vault, &*n_vault, &*quote_vault] {
        accounts::writable(v)?;
    }

    let series_key = *series.address().as_array();
    let (expected, bump) = Address::find_program_address(&[MARKET_SEED, &series_key], program_id);
    if market.address() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    let bump_seed = [bump];
    create_pda(
        payer,
        market,
        &[
            Seed::from(MARKET_SEED),
            Seed::from(&series_key[..]),
            Seed::from(&bump_seed[..]),
        ],
        MARKET_LEN,
        program_id,
    )?;

    // The three vaults, owned by the market PDA. The ATA program derives each
    // address itself and rejects anything else, which is the check Anchor's
    // `associated_token::` constraints were making.
    for (vault, mint) in [
        (&*p_vault, &*p_mint),
        (&*n_vault, &*n_mint),
        (&*quote_vault, &*quote_mint),
    ] {
        token::create_associated_token_account(
            associated_token_program,
            payer,
            vault,
            market,
            mint,
            system_program,
            token_program,
        )?;
    }

    let state = Market {
        series: series_key,
        p_mint: *p_mint.address().as_array(),
        n_mint: *n_mint.address().as_array(),
        quote_mint: *quote_mint.address().as_array(),
        p_vault: *p_vault.address().as_array(),
        n_vault: *n_vault.address().as_array(),
        quote_vault: *quote_vault.address().as_array(),
        maturity_ts,
        bump,
    };
    let mut data = market.try_borrow_mut()?;
    state.store(&mut data)?;
    Ok(())
}

fn initialize_book(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> ProgramResult {
    let [payer, market, book, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if args.is_empty() {
        return Err(MarketError::InvalidAmount.into());
    }
    let leg = Leg::from_tag(args[0])?;

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::writable(book)?;
    let market_state = load_market(program_id, market)?;
    require_open(&market_state)?;

    let market_key = *market.address().as_array();
    let leg_tag = [leg.tag()];
    let (expected, bump) =
        Address::find_program_address(&[BOOK_SEED, &market_key, &leg_tag], program_id);
    if book.address() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    let bump_seed = [bump];
    create_pda(
        payer,
        book,
        &[
            Seed::from(BOOK_SEED),
            Seed::from(&market_key[..]),
            Seed::from(&leg_tag[..]),
            Seed::from(&bump_seed[..]),
        ],
        BOOK_LEN,
        program_id,
    )?;

    let mut data = book.try_borrow_mut()?;
    BookView::initialize(&mut data, &market_key, leg, bump)?;
    Ok(())
}

/// The vault checks `deposit` and `withdraw` share: the quote vault is the one
/// the market names, and the base vault is the one for the leg this book
/// trades. Without the second, a trader could deposit N and be credited on the
/// P book.
fn check_vaults(
    market_state: &Market,
    leg: Leg,
    base_vault: &AccountView,
    quote_vault: &AccountView,
) -> Result<(), ProgramError> {
    accounts::key_is(quote_vault, &market_state.quote_vault)?;
    accounts::key_is(base_vault, &market_state.base_vault(leg))?;
    Ok(())
}

fn deposit(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [trader, market, book, base_vault, quote_vault, trader_base, trader_quote, token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let base_amount = read_u64(args, 0)?;
    let quote_amount = read_u64(args, 8)?;

    accounts::signer(trader)?;
    let market_state = load_market(program_id, market)?;
    require_open(&market_state)?;
    accounts::writable(book)?;
    accounts::owned_by_program(book, program_id)?;
    // `#[account(mut)]` on all four in the Anchor build. The token CPI would
    // fail on a read-only account anyway, but failing here matches what the
    // Anchor build returns rather than surfacing an SPL error instead.
    for a in [&*base_vault, &*quote_vault, &*trader_base, &*trader_quote] {
        accounts::writable(a)?;
    }

    if base_amount == 0 && quote_amount == 0 {
        return Err(MarketError::InvalidAmount.into());
    }

    let trader_key = *trader.address().as_array();
    let base_mint = accounts::token_account_mint(base_vault)?;
    let quote_mint = accounts::token_account_mint(quote_vault)?;
    // `token::authority = trader` -- a caller may not fund their slot out of
    // somebody else's account.
    accounts::token_account_is(trader_base, Some(&trader_key), &base_mint)?;
    accounts::token_account_is(trader_quote, Some(&trader_key), &quote_mint)?;

    let leg = check_book(program_id, book, market)?;
    check_vaults(&market_state, leg, base_vault, quote_vault)?;
    {
        let mut data = book.try_borrow_mut()?;
        let mut view = BookView::new(&mut data)?;
        let i = view.slot_for(&trader_key)?;
        let mut slot = view.slot(i);
        slot.base_free = slot
            .base_free
            .checked_add(base_amount)
            .ok_or(MarketError::MathOverflow)?;
        slot.quote_free = slot
            .quote_free
            .checked_add(quote_amount)
            .ok_or(MarketError::MathOverflow)?;
        view.set_slot(i, &slot);
    }

    // The transfers come after the ledger update so the account borrow is
    // released before the CPI; the runtime refuses a CPI while data is borrowed.
    if base_amount > 0 {
        token::transfer(
            token_program,
            trader_base,
            base_vault,
            trader,
            base_amount,
            &[],
        )?;
    }
    if quote_amount > 0 {
        token::transfer(
            token_program,
            trader_quote,
            quote_vault,
            trader,
            quote_amount,
            &[],
        )?;
    }

    events::deposited(
        book.address().as_array(),
        &trader_key,
        base_amount,
        quote_amount,
    );
    Ok(())
}

fn withdraw(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [trader, market, book, base_vault, quote_vault, trader_base, trader_quote, token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let base_amount = read_u64(args, 0)?;
    let quote_amount = read_u64(args, 8)?;

    accounts::signer(trader)?;
    // Deliberately not `require_open`: withdrawal has to work after maturity.
    let market_state = load_market(program_id, market)?;
    accounts::writable(book)?;
    accounts::owned_by_program(book, program_id)?;
    for a in [&*base_vault, &*quote_vault, &*trader_base, &*trader_quote] {
        accounts::writable(a)?;
    }

    if base_amount == 0 && quote_amount == 0 {
        return Err(MarketError::InvalidAmount.into());
    }

    let trader_key = *trader.address().as_array();
    let base_mint = accounts::token_account_mint(base_vault)?;
    let quote_mint = accounts::token_account_mint(quote_vault)?;
    accounts::token_account_is(trader_base, None, &base_mint)?;
    accounts::token_account_is(trader_quote, None, &quote_mint)?;

    let leg = check_book(program_id, book, market)?;
    check_vaults(&market_state, leg, base_vault, quote_vault)?;
    {
        let mut data = book.try_borrow_mut()?;
        let mut view = BookView::new(&mut data)?;
        let i = view
            .slot_index(&trader_key)
            .ok_or(MarketError::UnknownTrader)?;
        let mut slot = view.slot(i);
        if slot.base_free < base_amount || slot.quote_free < quote_amount {
            return Err(MarketError::InsufficientBalance.into());
        }
        slot.base_free -= base_amount;
        slot.quote_free -= quote_amount;
        view.set_slot(i, &slot);
        view.release_if_empty(i);
    }

    // The vault authority is the market PDA, so the transfers are signed.
    let market_bump = [market_state.bump];
    let seeds = [
        Seed::from(MARKET_SEED),
        Seed::from(&market_state.series[..]),
        Seed::from(&market_bump[..]),
    ];
    if base_amount > 0 {
        token::transfer(
            token_program,
            base_vault,
            trader_base,
            market,
            base_amount,
            &seeds,
        )?;
    }
    if quote_amount > 0 {
        token::transfer(
            token_program,
            quote_vault,
            trader_quote,
            market,
            quote_amount,
            &seeds,
        )?;
    }

    events::withdrawn(
        book.address().as_array(),
        &trader_key,
        base_amount,
        quote_amount,
    );
    Ok(())
}

/// `place`, `cancel` and `fill` share a shape: a signer, a market, a book, and
/// no token accounts at all. That is why they can run in a rollup.
/// `place`, `cancel` and `fill` share a shape: a signer, a market, a book, and
/// no token accounts at all. That is why they can run in a rollup.
///
/// The book is returned unattached -- the caller borrows it and builds the view
/// itself, so the 6 KB book is never a value on the stack.
fn trade_accounts<'a>(
    program_id: &Address,
    accounts: &'a mut [AccountView],
) -> Result<
    (
        &'a AccountView,
        &'a AccountView,
        &'a mut AccountView,
        Market,
    ),
    ProgramError,
> {
    let [trader, market, book, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::signer(trader)?;
    accounts::writable(book)?;
    accounts::owned_by_program(book, program_id)?;
    let market_state = load_market(program_id, market)?;
    Ok((&*trader, &*market, book, market_state))
}

fn place_order(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    if args.is_empty() {
        return Err(MarketError::InvalidAmount.into());
    }
    let is_bid = args[0] != 0;
    let price = read_u64(args, 1)?;
    let qty = read_u64(args, 9)?;

    let (trader, market, book, market_state) = trade_accounts(program_id, accounts)?;
    require_open(&market_state)?;

    let trader_key = *trader.address().as_array();
    check_book(program_id, book, market)?;
    let book_key = *book.address().as_array();
    let id = {
        let mut data = book.try_borrow_mut()?;
        let mut view = BookView::new(&mut data)?;
        view.place(&trader_key, is_bid, price, qty)?
    };
    events::order_placed(&book_key, &trader_key, id, is_bid, price, qty);
    Ok(())
}

fn cancel_order(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let id = read_u64(args, 0)?;
    // Deliberately no `require_open`: cancelling must work after maturity.
    let (trader, market, book, _market_state) = trade_accounts(program_id, accounts)?;
    let trader_key = *trader.address().as_array();
    check_book(program_id, book, market)?;
    let book_key = *book.address().as_array();
    {
        let mut data = book.try_borrow_mut()?;
        let mut view = BookView::new(&mut data)?;
        view.cancel(&trader_key, id)?;
    }
    events::order_cancelled(&book_key, &trader_key, id);
    Ok(())
}

fn fill_order(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let id = read_u64(args, 0)?;
    let qty = read_u64(args, 8)?;
    let (trader, market, book, market_state) = trade_accounts(program_id, accounts)?;
    require_open(&market_state)?;

    let taker = *trader.address().as_array();
    check_book(program_id, book, market)?;
    let book_key = *book.address().as_array();
    let filled = {
        let mut data = book.try_borrow_mut()?;
        let mut view = BookView::new(&mut data)?;
        view.fill(&taker, id, qty)?
    };
    events::order_filled(&book_key, &taker, id, filled);
    Ok(())
}

/// Hand the book to an ephemeral rollup.
///
/// The sequence is the delegation program's, not this program's: create a
/// buffer PDA owned by this program, copy the book into it, then hand the book
/// itself to the delegation program, which takes ownership. Until it is
/// undelegated, `deposit` and `withdraw` fail their owner check -- which is the
/// property that stops the rollup's ledger and the vaults from diverging.
fn delegate_book(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [payer, market, book, buffer, delegation_record, delegation_metadata, owner_program, delegation_program, system_program, rest @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if args.is_empty() {
        return Err(MarketError::InvalidAmount.into());
    }
    let leg = Leg::from_tag(args[0])?;

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::writable(book)?;
    accounts::writable(buffer)?;
    accounts::writable(delegation_record)?;
    accounts::writable(delegation_metadata)?;
    accounts::key_is(owner_program, program_id.as_array())?;
    accounts::key_is(delegation_program, &delegation::DELEGATION_PROGRAM_ID)?;

    let market_state = load_market(program_id, market)?;
    require_open(&market_state)?;

    let market_key = *market.address().as_array();
    let leg_tag = [leg.tag()];
    let book_seeds: [&[u8]; 3] = [BOOK_SEED, &market_key, &leg_tag];
    let (expected_book, book_bump) = Address::find_program_address(&book_seeds, program_id);
    if book.address() != &expected_book {
        return Err(ProgramError::InvalidSeeds);
    }

    // The buffer is a PDA of *this* program, seeded on the delegated account.
    let book_key = *book.address().as_array();
    let buffer_seeds: [&[u8]; 2] = [delegation::DELEGATE_BUFFER_TAG, &book_key];
    let (expected_buffer, buffer_bump) = Address::find_program_address(&buffer_seeds, program_id);
    if buffer.address() != &expected_buffer {
        return Err(ProgramError::InvalidSeeds);
    }

    let buffer_bump_seed = [buffer_bump];
    create_pda(
        payer,
        buffer,
        &[
            Seed::from(delegation::DELEGATE_BUFFER_TAG),
            Seed::from(&book_key[..]),
            Seed::from(&buffer_bump_seed[..]),
        ],
        BOOK_LEN,
        program_id,
    )?;

    // Copy the book into the buffer, then blank it: the delegation program
    // expects to receive an empty account it can take over.
    {
        let src = book.try_borrow()?;
        let mut dst = buffer.try_borrow_mut()?;
        let n = src.len().min(dst.len());
        dst[..n].copy_from_slice(&src[..n]);
    }
    {
        let mut b = book.try_borrow_mut()?;
        for byte in b.iter_mut() {
            *byte = 0;
        }
    }

    let validator = rest.first().map(|a| *a.address().as_array());
    let data = delegation::delegate(
        u32::MAX,
        &[BOOK_SEED, &market_key, &leg_tag],
        validator.as_ref(),
    )?;

    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable_signer(book.address()),
        InstructionAccount::readonly(owner_program.address()),
        InstructionAccount::writable(buffer.address()),
        InstructionAccount::writable(delegation_record.address()),
        InstructionAccount::writable(delegation_metadata.address()),
        InstructionAccount::readonly(system_program.address()),
    ];
    let ix = InstructionView {
        program_id: &Address::new_from_array(delegation::DELEGATION_PROGRAM_ID),
        accounts: &metas,
        data: data.as_slice(),
    };
    let views = [
        &*payer,
        &*book,
        &*owner_program,
        &*buffer,
        &*delegation_record,
        &*delegation_metadata,
        &*system_program,
    ];
    let book_bump_seed = [book_bump];
    invoke_signed(
        &ix,
        &views,
        &[Signer::from(&[
            Seed::from(BOOK_SEED),
            Seed::from(&market_key[..]),
            Seed::from(&leg_tag[..]),
            Seed::from(&book_bump_seed[..]),
        ])],
    )
}

/// `commit_book` and `undelegate_book`: schedule an intent with the magic
/// program. The only difference is which of the two bundle fields is populated.
fn schedule(program_id: &Address, accounts: &mut [AccountView], intent: Intent) -> ProgramResult {
    let [payer, book, magic_context, magic_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::writable(book)?;
    accounts::writable(magic_context)?;
    accounts::key_is(magic_context, &delegation::MAGIC_CONTEXT_ID)?;
    accounts::key_is(magic_program, &delegation::MAGIC_PROGRAM_ID)?;
    let _ = program_id;

    // Index 2 in the account list below is the book -- which is what the
    // bundle's committed-accounts index refers to.
    let data = delegation::schedule_intent_bundle(intent, 2)?;

    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(magic_context.address()),
        InstructionAccount::readonly(book.address()),
    ];
    let ix = InstructionView {
        program_id: &Address::new_from_array(delegation::MAGIC_PROGRAM_ID),
        accounts: &metas,
        data: data.as_slice(),
    };
    let views = [&*payer, &*magic_context, &*book];
    invoke(&ix, &views)
}

/// The callback the rollup invokes on exit, injected by `#[ephemeral]` in the
/// Anchor build. It hands the buffered state back to the account and returns
/// ownership to this program.
fn process_undelegation(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> ProgramResult {
    let [delegated_account, buffer, payer, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    // `account_seeds: Vec<Vec<u8>>` -- read but not trusted; the buffer's own
    // address is what proves which account this is for.
    let _ = args;

    accounts::writable(delegated_account)?;
    accounts::writable(payer)?;
    accounts::owned_by_program(buffer, program_id)?;

    let account_key = *delegated_account.address().as_array();
    let (expected_buffer, _) =
        Address::find_program_address(&[delegation::DELEGATE_BUFFER_TAG, &account_key], program_id);
    if buffer.address() != &expected_buffer {
        return Err(ProgramError::InvalidSeeds);
    }

    {
        let src = buffer.try_borrow()?;
        let mut dst = delegated_account.try_borrow_mut()?;
        let n = src.len().min(dst.len());
        dst[..n].copy_from_slice(&src[..n]);
    }

    // Reclaim the buffer's rent for the payer.
    let lamports = buffer.lamports();
    let credited = payer
        .lamports()
        .checked_add(lamports)
        .ok_or(MarketError::MathOverflow)?;
    payer.set_lamports(credited);
    buffer.set_lamports(0);
    buffer.close()?;
    Ok(())
}
