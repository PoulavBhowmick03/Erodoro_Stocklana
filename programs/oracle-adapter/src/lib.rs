// SPDX-License-Identifier: Apache-2.0
//! Oracle adapter.
//!
//! Pins a feed's identity in a config account, reads the Pyth price account
//! behind it, and returns a quote that is positive, timely, and tagged with
//! the feed id. Decimal normalization to the series' own precision is done by
//! the series with the shared math.
//!
//! Pyth is the only source. There is no mock and no test backend: a config
//! that could be pointed at an operator-written price would be the single
//! most dangerous thing in this repo, and the safest way to not ship it is to
//! not build it. Failure paths are exercised against real `PriceUpdateV2`
//! bytes with individual fields varied — see `tests/fixtures`.
//!
//! # This is a library, not a CPI target
//!
//! The price account has to be passed into the transaction anyway, so a CPI
//! would buy nothing but compute units. Instead this program *owns*
//! [`FeedConfig`]
//! accounts — which is what makes the feed's identity tamper-evident — and
//! exports [`read_quote_at_or_after`] as a plain function that `series` links
//! in with `features = ["no-entrypoint"]`. Anchor's owner check on
//! `Account<'info, FeedConfig>` is what ties the two together.
//!
//! # Pyth publishes no trading status on-chain
//!
//! The design assumed Pyth equity feeds carry a trading status settlement can
//! gate on. That is true of Hermes metadata and of the legacy pythnet price
//! account, but **not** of `PriceUpdateV2`, the account the Solana receiver
//! actually writes: it carries `feed_id`, `price`, `conf`, `exponent` and
//! `publish_time`, and nothing else.
//!
//! So the market-status requirement is met structurally instead. A series only
//! accepts a print inside a settlement window placed at a real market close
//! (`series::require_settlement_window`). That is the load-bearing check, and
//! it holds without asking the oracle anything it cannot answer.

#![allow(unexpected_cfgs)]
// Anchor 0.31's generated entrypoint calls deprecated `AccountInfo::realloc`.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use common::{
    math::{pow10, MAX_DECIMALS},
    OptionsError, PriceData,
};

pub mod pyth;
use pyth::{PriceUpdateV2, PYTH_RECEIVER_ID};

declare_id!("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");

pub const FEED_CONFIG_SEED: &[u8] = b"feed-config";

#[program]
pub mod oracle_adapter {
    use super::*;

    /// Pin a feed: its id, the one account quotes may be read from, how that
    /// account is decoded, and how stale a quote may be.
    pub fn initialize_feed_config(
        ctx: Context<InitializeFeedConfig>,
        feed_id: [u8; 32],
        max_age_secs: i64,
        min_verification_signatures: u8,
    ) -> Result<()> {
        validate_feed_config_params(max_age_secs, min_verification_signatures)?;
        validate_pyth_source(&ctx.accounts.source, feed_id, min_verification_signatures)?;
        let cfg = &mut ctx.accounts.feed_config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.feed_id = feed_id;
        cfg.source = ctx.accounts.source.key();
        cfg.max_age_secs = max_age_secs;
        cfg.min_verification_signatures = min_verification_signatures;
        cfg.bump = ctx.bumps.feed_config;
        Ok(())
    }

    /// Repoint the config at a new Pyth price account for the same feed.
    ///
    /// The feed id is deliberately not settable — repointing at a different
    /// asset is the obvious attack. Rotating the *account* is what this exists
    /// for: Pyth price updates are posted fresh, and the quote's own feed id
    /// is checked on every read, so a rotation cannot change what is settled
    /// against.
    pub fn set_source(ctx: Context<UpdateFeedConfig>) -> Result<()> {
        let cfg = &mut ctx.accounts.feed_config;
        validate_pyth_source(
            &ctx.accounts.source,
            cfg.feed_id,
            cfg.min_verification_signatures,
        )?;
        cfg.source = ctx.accounts.source.key();
        Ok(())
    }

    pub fn set_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.feed_config.admin = new_admin;
        Ok(())
    }

    /// Read the current quote and return it as instruction return data.
    ///
    /// Read-only convenience for off-chain tooling and previews; settlement
    /// calls [`read_quote_at_or_after`] directly rather than going through a
    /// CPI.
    pub fn preview_quote(ctx: Context<ReadQuote>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let quote = read_quote(&ctx.accounts.feed_config, &ctx.accounts.source, now)?;
        anchor_lang::solana_program::program::set_return_data(&quote.try_to_vec()?);
        Ok(())
    }
}

/// Reject feed configurations that make freshness or source authentication
/// vacuous. Kept framework-free so creation policy has direct unit coverage.
pub fn validate_feed_config_params(
    max_age_secs: i64,
    min_verification_signatures: u8,
) -> Result<()> {
    require!(max_age_secs > 0, OptionsError::InvalidParams);
    require!(min_verification_signatures > 0, OptionsError::InvalidParams);
    Ok(())
}

/// Immutable-ish identity of a price feed. `feed_id` never changes; the
/// account it is read from can be rotated by the admin.
#[account]
#[derive(InitSpace)]
pub struct FeedConfig {
    pub admin: Pubkey,
    /// Pyth feed id for the pair. Every quote is checked against this, so a
    /// series can never settle against the price of a different asset.
    pub feed_id: [u8; 32],
    pub source: Pubkey,
    /// Maximum accepted staleness of a quote relative to the cluster clock.
    pub max_age_secs: i64,
    /// Minimum guardian signatures a partially-verified Pyth update must
    /// carry. `VerificationLevel::Full` always clears it. A zero floor accepts
    /// an update backed by no signatures at all, so mainnet configs must set
    /// this.
    pub min_verification_signatures: u8,
    pub bump: u8,
}

// --- Quote reading --------------------------------------------------------

/// Decode and validate the quote behind `feed_config`, without any reference
/// to a particular series.
///
/// Checks, in order: the account is the one the config names; it is owned by
/// the program that produces that kind of quote; its feed id matches; the
/// price is positive; the publish time is not in the future; and the quote is
/// no older than `max_age_secs`.
pub fn read_quote(feed_config: &FeedConfig, source: &AccountInfo, now: i64) -> Result<PriceData> {
    require_keys_eq!(source.key(), feed_config.source, OptionsError::FeedMismatch);

    let quote = validate_pyth_source(
        source,
        feed_config.feed_id,
        feed_config.min_verification_signatures,
    )?;
    require!(quote.price > 0, OptionsError::OraclePriceInvalid);
    require!(quote.timestamp <= now, OptionsError::OraclePriceInvalid);
    require!(
        now.saturating_sub(quote.timestamp) <= feed_config.max_age_secs,
        OptionsError::OraclePriceStale
    );

    Ok(quote)
}

/// Validate the immutable properties required before a source address is
/// stored. Price and timestamp checks remain read-time concerns because those
/// fields naturally change as Pyth posts new updates.
fn validate_pyth_source(
    source: &AccountInfo,
    feed_id: [u8; 32],
    min_signatures: u8,
) -> Result<PriceData> {
    let quote = decode_pyth(source, min_signatures)?;
    require!(quote.feed_id == feed_id, OptionsError::FeedMismatch);
    Ok(quote)
}

/// The settlement read: a validated quote whose publish time is at or after
/// `after_ts` (the series' maturity) and no older than `max_age_secs`.
///
/// The series passes its own `max_age_secs`, so a long-dated series and a
/// weekly one can share a feed config without sharing a staleness tolerance.
pub fn read_quote_at_or_after(
    feed_config: &FeedConfig,
    source: &AccountInfo,
    now: i64,
    after_ts: i64,
    max_age_secs: i64,
) -> Result<PriceData> {
    let quote = read_quote(feed_config, source, now)?;
    require!(quote.timestamp >= after_ts, OptionsError::OraclePriceStale);
    require!(
        now.saturating_sub(quote.timestamp) <= max_age_secs,
        OptionsError::OraclePriceStale
    );
    Ok(quote)
}

fn decode_pyth(source: &AccountInfo, min_signatures: u8) -> Result<PriceData> {
    require_keys_eq!(*source.owner, PYTH_RECEIVER_ID, OptionsError::InvalidOracle);
    let data = source.try_borrow_data()?;
    let update = PriceUpdateV2::try_from_account_data(&data)?;
    require!(
        update.verification_level.meets(min_signatures),
        OptionsError::OraclePriceInvalid
    );
    let msg = update.price_message;
    let (price, decimals) = scale_from_expo(msg.price, msg.exponent)?;
    Ok(PriceData {
        feed_id: msg.feed_id,
        price,
        decimals,
        timestamp: msg.publish_time,
    })
}

/// Turn a Pyth-style signed exponent into the unsigned decimal count the
/// shared math works in.
///
/// A negative exponent is the normal case and maps straight across: `-8` means
/// the integer carries 8 decimals. A non-negative exponent means the integer
/// is *coarser* than one unit, so it is materialized at 0 decimals rather than
/// pretending to a precision it does not have.
pub fn scale_from_expo(price: i64, expo: i32) -> Result<(i128, u32)> {
    let price = price as i128;
    if expo <= 0 {
        let decimals = expo.unsigned_abs();
        require!(
            decimals <= MAX_DECIMALS,
            OptionsError::OracleDecimalsInvalid
        );
        Ok((price, decimals))
    } else {
        let exp = expo as u32;
        require!(exp <= MAX_DECIMALS, OptionsError::OracleDecimalsInvalid);
        let factor = pow10(exp)?;
        let scaled = price
            .checked_mul(factor)
            .ok_or(OptionsError::MathOverflow)?;
        Ok((scaled, 0))
    }
}

// --- Accounts -------------------------------------------------------------

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct InitializeFeedConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub admin: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + FeedConfig::INIT_SPACE,
        seeds = [FEED_CONFIG_SEED, feed_id.as_ref()],
        bump,
    )]
    pub feed_config: Account<'info, FeedConfig>,

    /// The Pyth price account quotes are read from.
    /// CHECK: decoded as `PriceUpdateV2`, Pyth-receiver-owner-checked, and
    /// feed-id-checked before its address is stored and again on every read.
    pub source: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFeedConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin)]
    pub feed_config: Account<'info, FeedConfig>,

    /// CHECK: see `InitializeFeedConfig::source`.
    pub source: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin)]
    pub feed_config: Account<'info, FeedConfig>,
}

#[derive(Accounts)]
pub struct ReadQuote<'info> {
    pub feed_config: Account<'info, FeedConfig>,

    /// CHECK: validated against `feed_config.source` inside `read_quote`.
    pub source: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_configuration_requires_freshness_and_authentication() {
        assert!(validate_feed_config_params(120, 13).is_ok());
        assert!(validate_feed_config_params(0, 13).is_err());
        assert!(validate_feed_config_params(120, 0).is_err());
    }

    #[test]
    fn negative_exponent_maps_to_decimals() {
        // The TSLA/USD case: -8 means the integer carries 8 decimals.
        assert_eq!(
            scale_from_expo(400_00000000, -8).unwrap(),
            (400_00000000, 8)
        );
        // A coarser feed at -5.
        assert_eq!(scale_from_expo(400_00000, -5).unwrap(), (400_00000, 5));
        assert_eq!(scale_from_expo(7, 0).unwrap(), (7, 0));
    }

    #[test]
    fn positive_exponent_materializes_at_zero_decimals() {
        // expo 2 means each integer unit is 100, so 5 is really 500.
        assert_eq!(scale_from_expo(5, 2).unwrap(), (500, 0));
    }

    #[test]
    fn absurd_exponents_are_rejected() {
        assert!(scale_from_expo(1, -19).is_err());
        assert!(scale_from_expo(1, 19).is_err());
    }
}
