// SPDX-License-Identifier: Apache-2.0
//! Oracle adapter — Quasar variant.
//!
//! Third build of the same program, for the same reason as the Pinocchio one:
//! deploy rent is `bytes * 6960` lamports, so the only way to price a framework
//! is to build the identical program on it.
//!
//! # Where Quasar sits between the other two
//!
//! Anchor derives the account checks and pays for it in binary size. Pinocchio
//! removes the framework entirely and hands the checks back to you. Quasar
//! keeps `#[derive(Accounts)]` — so ownership, signer, PDA and `init` are still
//! declared rather than hand-written — while casting accounts straight out of
//! the input buffer instead of deserializing them.
//!
//! That matters more than the byte count for this codebase: the checks are the
//! security model, and the Pinocchio variant's `accounts` module is the part
//! that would need re-auditing on every change. Here it stays declarative.
//!
//! # Caveat
//!
//! Quasar is beta and explicitly unaudited, with APIs subject to change. This
//! variant is a measurement, not a recommendation to ship on it.

#![no_std]
#![allow(unexpected_cfgs)]

pub mod error;
pub mod pyth;
pub mod quote;
pub mod state;

use {
    error::OptionsError,
    quasar_lang::prelude::*,
    quote::read_quote,
    state::{FeedConfigData, FEED_CONFIG_SEED},
};

declare_id!("AZnVLRAsvnrmQ2CjybYaeHWLw2TpsUrWMDQUoE9WEnec");

/// The feed config account.
///
/// The 8-byte discriminator is `sha256("account:FeedConfig")[..8]`, matching
/// what Anchor writes, so an account created by either build is readable by the
/// other. Quasar's default is a compact one-byte tag; spending the extra seven
/// bytes buys cross-variant compatibility, which is the whole point of running
/// three builds of one program.
#[account(discriminator = [75, 97, 12, 15, 89, 221, 78, 71], set_inner)]
#[seeds(b"feed-config", feed_id: [u8; 32])]
pub struct FeedConfig {
    pub admin: Address,
    /// Pyth feed id for the pair. Every quote is checked against this, so a
    /// series can never settle against the price of a different asset.
    pub feed_id: [u8; 32],
    pub source: Address,
    /// Maximum accepted staleness of a quote relative to the cluster clock.
    pub max_age_secs: i64,
    /// Minimum guardian signatures a partially-verified Pyth update must carry.
    /// `Full` always clears it. A zero floor accepts an update backed by no
    /// signatures at all, so mainnet configs must set this.
    pub min_verification_signatures: u8,
    pub bump: u8,
}

#[program]
mod oracle_adapter_quasar {
    use super::*;

    /// Pin a feed: its id, the one account quotes may be read from, and how
    /// stale a quote may be.
    #[instruction(discriminator = [200, 171, 105, 168, 38, 246, 232, 70])]
    pub fn initialize_feed_config(
        ctx: Ctx<InitializeFeedConfig>,
        feed_id: [u8; 32],
        max_age_secs: i64,
        min_verification_signatures: u8,
    ) -> Result<(), ProgramError> {
        ctx.accounts.initialize(
            feed_id,
            max_age_secs,
            min_verification_signatures,
            ctx.bumps.feed_config,
        )
    }

    /// Repoint the config at a new Pyth price account for the same feed.
    ///
    /// The feed id is deliberately not settable — repointing at a different
    /// asset is the obvious attack. Rotating the *account* is what this exists
    /// for: the quote's own feed id is checked on every read, so a rotation
    /// cannot change what is settled against.
    #[instruction(discriminator = [136, 61, 231, 10, 214, 70, 18, 31])]
    pub fn set_source(ctx: Ctx<UpdateFeedConfig>) -> Result<(), ProgramError> {
        ctx.accounts.set_source()
    }

    #[instruction(discriminator = [251, 163, 0, 52, 91, 194, 187, 92])]
    pub fn set_admin(ctx: Ctx<UpdateAdmin>, new_admin: Address) -> Result<(), ProgramError> {
        ctx.accounts.set_admin(new_admin)
    }

    /// Read the current quote and return it as instruction return data.
    #[instruction(discriminator = [52, 81, 141, 141, 0, 130, 206, 20])]
    pub fn preview_quote(ctx: Ctx<ReadQuote>) -> Result<(), ProgramError> {
        ctx.accounts.preview_quote()
    }
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct InitializeFeedConfig {
    #[account(mut)]
    pub payer: Signer,
    pub admin: Signer,
    #[account(init, payer = payer, address = FeedConfig::seeds(feed_id))]
    pub feed_config: Account<FeedConfig>,
    /// Decoded and owner-checked at read time; stored here only as the address
    /// that may be presented.
    pub source: UncheckedAccount,
    pub system_program: Program<SystemProgram>,
}

impl InitializeFeedConfig {
    #[inline(always)]
    pub fn initialize(
        &mut self,
        feed_id: [u8; 32],
        max_age_secs: i64,
        min_verification_signatures: u8,
        bump: u8,
    ) -> Result<(), ProgramError> {
        if max_age_secs <= 0 {
            return Err(OptionsError::InvalidParams.into());
        }
        self.feed_config.set_inner(FeedConfigInner {
            admin: *self.admin.address(),
            feed_id,
            source: *self.source.address(),
            max_age_secs,
            min_verification_signatures,
            bump,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateFeedConfig {
    pub admin: Signer,
    #[account(mut, has_one(admin))]
    pub feed_config: Account<FeedConfig>,
    pub source: UncheckedAccount,
}

impl UpdateFeedConfig {
    #[inline(always)]
    pub fn set_source(&mut self) -> Result<(), ProgramError> {
        self.feed_config.source = *self.source.address();
        Ok(())
    }
}

#[derive(Accounts)]
pub struct UpdateAdmin {
    pub admin: Signer,
    #[account(mut, has_one(admin))]
    pub feed_config: Account<FeedConfig>,
}

impl UpdateAdmin {
    #[inline(always)]
    pub fn set_admin(&mut self, new_admin: Address) -> Result<(), ProgramError> {
        self.feed_config.admin = new_admin;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadQuote {
    pub feed_config: Account<FeedConfig>,
    /// Validated against `feed_config.source` inside `read_quote`.
    pub source: UncheckedAccount,
}

impl ReadQuote {
    #[inline(always)]
    pub fn preview_quote(&self) -> Result<(), ProgramError> {
        let cfg = FeedConfigData {
            admin: *self.feed_config.admin.as_array(),
            feed_id: self.feed_config.feed_id,
            source: *self.feed_config.source.as_array(),
            max_age_secs: self.feed_config.max_age_secs,
            min_verification_signatures: self.feed_config.min_verification_signatures,
            bump: self.feed_config.bump,
        };

        let data = self.source.try_borrow()?;
        let now = Clock::get()?.unix_timestamp;
        let quote = read_quote(
            &cfg,
            self.source.address().as_array(),
            self.source.owner().as_array(),
            &data,
            now,
        )?;

        // Same wire shape as the Anchor variant's `PriceData::try_to_vec()`:
        // feed_id ++ price(i128) ++ decimals(u32) ++ timestamp(i64).
        let mut out = [0u8; 32 + 16 + 4 + 8];
        out[..32].copy_from_slice(&quote.feed_id);
        out[32..48].copy_from_slice(&quote.price.to_le_bytes());
        out[48..52].copy_from_slice(&quote.decimals.to_le_bytes());
        out[52..60].copy_from_slice(&quote.timestamp.to_le_bytes());
        set_return_data(&out);
        Ok(())
    }
}
