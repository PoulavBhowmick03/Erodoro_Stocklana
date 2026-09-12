// SPDX-License-Identifier: Apache-2.0
//! An order book for a series' P and N tokens. The intended quote asset is
//! USDC, but the current account constraints do not enforce that identity.
//!
//! This exists because of the one problem no contract in this repo solves:
//! the P holder's entire compensation for capping their upside is the premium
//! from selling N, and that premium only exists if somebody can profitably
//! quote N. Today they cannot. A market maker has to reprice N every time spot
//! moves, and if each quote update costs a fee and lands 400ms later, the
//! spread they must charge to survive is wider than the premium is worth.
//!
//! So the hot path moves to an ephemeral rollup, where quoting is free and
//! lands in tens of milliseconds, and the money stays on Solana.
//!
//! # What lives where
//!
//! **Solana keeps everything that holds value.** The vaults are real token
//! accounts owned by this program's PDA. Deposits and withdrawals are L1
//! instructions. The collateral, the claim mints and the settlement record all
//! belong to the `series` program and are never touched here.
//!
//! **The rollup keeps only the ledger.** [`Book`] — orders and per-trader
//! balances together — is the single account delegated to a session. Matching
//! mutates it and nothing else; no tokens move until someone withdraws.
//!
//! Orders and balances share one account deliberately. Per-trader PDAs would
//! be more idiomatic on L1 and much worse here: every match would need both
//! sides' accounts delegated to the same validator, and a maker who
//! undelegated mid-session would silently become unfillable.
//!
//! # The safety property, for free
//!
//! While [`Book`] is delegated it is owned by the delegation program, so
//! `deposit` and `withdraw` — which take it as `Account<'info, Book>` — fail
//! Anchor's owner check without a line of code. A balance cannot be withdrawn
//! on L1 while a rollup is still mutating it, so the ledger and the vaults
//! cannot diverge.
//!
//! # The one rule this program has to enforce itself
//!
//! Nothing in the delegation model stops a book trading past its series'
//! maturity. At settlement P and N stop being trading instruments and become
//! claims on a frozen pool, so [`place_order`] and [`fill_order`] refuse once
//! `maturity_ts` has passed. Undelegate before then.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

pub mod logic;
pub mod state;

use logic::{require_open_at, MarketError};
use state::{Book, Leg, Market, MAX_ORDERS, MAX_TRADERS};

declare_id!("FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC");

pub const MARKET_SEED: &[u8] = b"market";
pub const BOOK_SEED: &[u8] = b"book";

#[ephemeral]
#[program]
pub mod market {
    use super::*;

    /// Wire a market to a series: the two claim mints, the quote mint, and
    /// three vaults owned by the market PDA.
    pub fn initialize_market(ctx: Context<InitializeMarket>, maturity_ts: i64) -> Result<()> {
        require_open_at(maturity_ts, Clock::get()?.unix_timestamp)?;
        let m = &mut ctx.accounts.market;
        m.series = ctx.accounts.series.key();
        m.p_mint = ctx.accounts.p_mint.key();
        m.n_mint = ctx.accounts.n_mint.key();
        m.quote_mint = ctx.accounts.quote_mint.key();
        m.p_vault = ctx.accounts.p_vault.key();
        m.n_vault = ctx.accounts.n_vault.key();
        m.quote_vault = ctx.accounts.quote_vault.key();
        m.maturity_ts = maturity_ts;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Open the book for one leg. Capacity is fixed: a delegated account
    /// cannot be reallocated.
    pub fn initialize_book(ctx: Context<InitializeBook>, leg: Leg) -> Result<()> {
        require_open(&ctx.accounts.market)?;
        let b = &mut ctx.accounts.book;
        b.market = ctx.accounts.market.key();
        b.leg = leg;
        b.slots = vec![];
        b.orders = vec![];
        b.next_order_id = 1;
        b.volume_base = 0;
        b.bump = ctx.bumps.book;
        Ok(())
    }

    /// Move tokens into the vaults and credit the trader's slot. L1 only —
    /// while the book is delegated this instruction cannot even deserialize
    /// it.
    pub fn deposit(ctx: Context<Deposit>, base_amount: u64, quote_amount: u64) -> Result<()> {
        require_open(&ctx.accounts.market)?;
        require!(
            base_amount > 0 || quote_amount > 0,
            MarketError::InvalidAmount
        );

        if base_amount > 0 {
            token::transfer(ctx.accounts.base_in(), base_amount)?;
        }
        if quote_amount > 0 {
            token::transfer(ctx.accounts.quote_in(), quote_amount)?;
        }

        let trader = ctx.accounts.trader.key();
        let book = &mut ctx.accounts.book;
        let i = book.slot_for(&trader)?;
        book.slots[i].base_free = book.slots[i]
            .base_free
            .checked_add(base_amount)
            .ok_or(MarketError::MathOverflow)?;
        book.slots[i].quote_free = book.slots[i]
            .quote_free
            .checked_add(quote_amount)
            .ok_or(MarketError::MathOverflow)?;

        emit!(Deposited {
            book: book.key(),
            trader,
            base_amount,
            quote_amount
        });
        Ok(())
    }

    /// Debit the trader's slot and send the tokens back. Only unlocked
    /// balances can leave; resting orders hold the rest.
    pub fn withdraw(ctx: Context<Withdraw>, base_amount: u64, quote_amount: u64) -> Result<()> {
        require!(
            base_amount > 0 || quote_amount > 0,
            MarketError::InvalidAmount
        );

        let trader = ctx.accounts.trader.key();
        let book_key = ctx.accounts.book.key();
        let book = &mut ctx.accounts.book;
        let i = book
            .slot_index(&trader)
            .ok_or(error!(MarketError::UnknownTrader))?;

        require!(
            book.slots[i].base_free >= base_amount && book.slots[i].quote_free >= quote_amount,
            MarketError::InsufficientBalance
        );
        book.slots[i].base_free -= base_amount;
        book.slots[i].quote_free -= quote_amount;
        book.release_if_empty(i);

        let seeds: &[&[u8]] = &[
            MARKET_SEED,
            ctx.accounts.market.series.as_ref(),
            &[ctx.accounts.market.bump],
        ];
        if base_amount > 0 {
            token::transfer(ctx.accounts.base_out().with_signer(&[seeds]), base_amount)?;
        }
        if quote_amount > 0 {
            token::transfer(ctx.accounts.quote_out().with_signer(&[seeds]), quote_amount)?;
        }

        emit!(Withdrawn {
            book: book_key,
            trader,
            base_amount,
            quote_amount
        });
        Ok(())
    }

    // --- the hot path, normally run inside a rollup session ---------------

    pub fn place_order(ctx: Context<Trade>, is_bid: bool, price: u64, qty: u64) -> Result<()> {
        require_open(&ctx.accounts.market)?;
        let trader = ctx.accounts.trader.key();
        let id = ctx.accounts.book.place(&trader, is_bid, price, qty)?;
        emit!(OrderPlaced {
            book: ctx.accounts.book.key(),
            trader,
            id,
            is_bid,
            price,
            qty
        });
        Ok(())
    }

    pub fn cancel_order(ctx: Context<Trade>, id: u64) -> Result<()> {
        let trader = ctx.accounts.trader.key();
        ctx.accounts.book.cancel(&trader, id)?;
        emit!(OrderCancelled {
            book: ctx.accounts.book.key(),
            trader,
            id
        });
        Ok(())
    }

    /// Cross against a resting order at the maker's price.
    pub fn fill_order(ctx: Context<Trade>, id: u64, qty: u64) -> Result<()> {
        require_open(&ctx.accounts.market)?;
        let taker = ctx.accounts.trader.key();
        let filled = ctx.accounts.book.fill(&taker, id, qty)?;
        emit!(OrderFilled {
            book: ctx.accounts.book.key(),
            taker,
            id,
            filled
        });
        Ok(())
    }

    // --- rollup session lifecycle -----------------------------------------

    /// Hand the book to an ephemeral rollup. Everything above still works;
    /// it just runs there instead, for free and in milliseconds.
    pub fn delegate_book(ctx: Context<DelegateBook>, leg: Leg) -> Result<()> {
        require_open(&ctx.accounts.market)?;
        ctx.accounts.delegate_book(
            &ctx.accounts.payer,
            &[BOOK_SEED, ctx.accounts.market.key().as_ref(), &[leg.tag()]],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Push the current ledger to L1 without ending the session.
    pub fn commit_book(ctx: Context<CommitBook>) -> Result<()> {
        ctx.accounts.book.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.book.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// End the session and return the book to this program.
    ///
    /// Withdrawals are impossible until this lands, so it is the instruction
    /// that matters operationally: run it before the series matures.
    pub fn undelegate_book(ctx: Context<CommitBook>) -> Result<()> {
        ctx.accounts.book.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.book.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

/// Trading stops at maturity. After it, P and N are claims on a frozen pool
/// rather than instruments, and a book still quoting them would be pricing
/// something already decided.
fn require_open(market: &Account<Market>) -> Result<()> {
    require_open_at(market.maturity_ts, Clock::get()?.unix_timestamp)
}

// --- accounts -------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the `series::SeriesConfig` this market quotes. Read only as an
    /// identifier — the market has no authority over it and never will.
    pub series: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, series.key().as_ref()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    pub p_mint: Box<Account<'info, Mint>>,
    pub n_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = p_mint,
        associated_token::authority = market,
    )]
    pub p_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = n_mint,
        associated_token::authority = market,
    )]
    pub n_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = market,
    )]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(leg: Leg)]
pub struct InitializeBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Book::INIT_SPACE,
        seeds = [BOOK_SEED, market.key().as_ref(), &[leg.tag()]],
        bump,
    )]
    pub book: Box<Account<'info, Book>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub trader: Signer<'info>,

    #[account(has_one = quote_vault)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, has_one = market)]
    pub book: Box<Account<'info, Book>>,

    #[account(mut, constraint = base_vault.key() == market.base_vault(book.leg))]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::authority = trader, token::mint = base_vault.mint)]
    pub trader_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = trader, token::mint = quote_vault.mint)]
    pub trader_quote: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

impl<'info> Deposit<'info> {
    fn base_in(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.trader_base.to_account_info(),
                to: self.base_vault.to_account_info(),
                authority: self.trader.to_account_info(),
            },
        )
    }
    fn quote_in(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.trader_quote.to_account_info(),
                to: self.quote_vault.to_account_info(),
                authority: self.trader.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub trader: Signer<'info>,

    #[account(has_one = quote_vault)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, has_one = market)]
    pub book: Box<Account<'info, Book>>,

    #[account(mut, constraint = base_vault.key() == market.base_vault(book.leg))]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = base_vault.mint)]
    pub trader_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_vault.mint)]
    pub trader_quote: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

impl<'info> Withdraw<'info> {
    fn base_out(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.base_vault.to_account_info(),
                to: self.trader_base.to_account_info(),
                authority: self.market.to_account_info(),
            },
        )
    }
    fn quote_out(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.quote_vault.to_account_info(),
                to: self.trader_quote.to_account_info(),
                authority: self.market.to_account_info(),
            },
        )
    }
}

/// Placing, cancelling and filling. No token accounts at all — this is why it
/// can run in a rollup.
#[derive(Accounts)]
pub struct Trade<'info> {
    pub trader: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(mut, has_one = market)]
    pub book: Box<Account<'info, Book>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBook<'info> {
    pub payer: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: handed to the delegation program, which takes ownership.
    #[account(mut, del)]
    pub book: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub book: Box<Account<'info, Book>>,
}

// --- events ---------------------------------------------------------------

#[event]
pub struct Deposited {
    pub book: Pubkey,
    pub trader: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[event]
pub struct Withdrawn {
    pub book: Pubkey,
    pub trader: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[event]
pub struct OrderPlaced {
    pub book: Pubkey,
    pub trader: Pubkey,
    pub id: u64,
    pub is_bid: bool,
    pub price: u64,
    pub qty: u64,
}

#[event]
pub struct OrderCancelled {
    pub book: Pubkey,
    pub trader: Pubkey,
    pub id: u64,
}

#[event]
pub struct OrderFilled {
    pub book: Pubkey,
    pub taker: Pubkey,
    pub id: u64,
    pub filled: u64,
}

/// Capacities, exposed so clients can refuse to build a transaction that
/// would fail on-chain.
#[constant]
pub const BOOK_MAX_TRADERS: u64 = MAX_TRADERS as u64;
#[constant]
pub const BOOK_MAX_ORDERS: u64 = MAX_ORDERS as u64;
