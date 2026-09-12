// SPDX-License-Identifier: Apache-2.0
//! Oracle adapter — Pinocchio variant.
//!
//! Semantically identical to `programs/oracle-adapter` (the Anchor build): same
//! program id, same account layout, same instruction encoding, same error
//! codes. It exists to measure what the framework costs in deploy rent, since
//! rent is `bytes * 6960` lamports and nothing else.
//!
//! # What changes without Anchor
//!
//! Anchor's `#[derive(Accounts)]` generates the ownership, signer, PDA and
//! discriminator checks. None of that exists here, so every one of them is
//! written out in [`accounts`]. That is the real cost of this variant and the
//! reason the Anchor build stays the reference: those checks *are* the security
//! model, and here they are hand-maintained rather than derived.
//!
//! Instruction encoding matches Anchor's: an 8-byte
//! `sha256("global:<name>")[..8]` discriminator followed by borsh-encoded
//! arguments, all of which are fixed-width here.

#![cfg_attr(not(test), no_std)]
// The entrypoint macros emit `cfg(target_os = "solana")`, which the host
// toolchain does not know about.
#![allow(unexpected_cfgs)]

pub mod error;
pub mod pyth;
pub mod quote;
pub mod state;

use {
    error::OptionsError,
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::{Seed, Signer},
        error::ProgramError,
        sysvars::{clock::Clock, rent::ACCOUNT_STORAGE_OVERHEAD, Sysvar},
        ProgramResult,
    },
    quote::{read_quote, validate_feed_config_params, validate_pyth_source},
    state::{FeedConfig, FEED_CONFIG_LEN, FEED_CONFIG_SEED},
};

pinocchio_pubkey::declare_id!("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");

/// Lamports per byte for a rent-exempt account: `lamports_per_byte_year` (3480)
/// times the two-year exemption threshold. Matches pinocchio's own
/// `DEFAULT_LAMPORTS_PER_BYTE`, and the value the runtime actually enforces.
const LAMPORTS_PER_BYTE: u64 = 6960;

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(process_instruction);
// `no_allocator!` and `nostd_panic_handler!` rather than the `default_*` pair:
// this crate is genuinely `no_std`, so it needs a real `#[panic_handler]`, and
// nothing here allocates.
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::no_allocator!();
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

/// Anchor instruction discriminators: `sha256("global:<snake_case_name>")[..8]`.
/// Derived in the tests rather than trusted as literals.
pub mod ix {
    pub const INITIALIZE_FEED_CONFIG: [u8; 8] = [200, 171, 105, 168, 38, 246, 232, 70];
    pub const SET_SOURCE: [u8; 8] = [136, 61, 231, 10, 214, 70, 18, 31];
    pub const SET_ADMIN: [u8; 8] = [251, 163, 0, 52, 91, 194, 187, 92];
    pub const PREVIEW_QUOTE: [u8; 8] = [52, 81, 141, 141, 0, 130, 206, 20];
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 8 {
        return Err(OptionsError::InvalidParams.into());
    }
    let (disc, args) = data.split_at(8);
    let disc: [u8; 8] = disc.try_into().map_err(|_| ProgramError::InvalidArgument)?;

    match disc {
        ix::INITIALIZE_FEED_CONFIG => initialize_feed_config(program_id, accounts, args),
        ix::SET_SOURCE => set_source(program_id, accounts),
        ix::SET_ADMIN => set_admin(program_id, accounts, args),
        ix::PREVIEW_QUOTE => preview_quote(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The checks Anchor would have generated, written once and shared.
mod accounts {
    use super::*;

    /// `Account<'info, FeedConfig>`: owned by this program. The discriminator
    /// half of Anchor's check lives in [`FeedConfig::load`].
    pub fn owned_by_program(
        account: &AccountView,
        program_id: &Address,
    ) -> Result<(), ProgramError> {
        if account.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        Ok(())
    }

    /// `Signer<'info>`.
    pub fn signer(account: &AccountView) -> Result<(), ProgramError> {
        if !account.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        Ok(())
    }

    /// `#[account(mut)]`.
    pub fn writable(account: &AccountView) -> Result<(), ProgramError> {
        if !account.is_writable() {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }

    /// `has_one = admin`. Anchor emits this from the attribute; here it is the
    /// caller's job to remember, which is exactly the hazard this variant buys.
    pub fn has_admin(cfg: &FeedConfig, admin: &AccountView) -> Result<(), ProgramError> {
        if &cfg.admin != admin.address().as_array() {
            return Err(OptionsError::Unauthorized.into());
        }
        Ok(())
    }
}

fn initialize_feed_config(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> ProgramResult {
    // borsh: [u8; 32] ++ i64 ++ u8, all fixed width.
    if args.len() < 41 {
        return Err(OptionsError::InvalidParams.into());
    }
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&args[..32]);
    let max_age_secs = i64::from_le_bytes(args[32..40].try_into().unwrap());
    let min_verification_signatures = args[40];

    validate_feed_config_params(max_age_secs, min_verification_signatures)?;

    let [payer, admin, feed_config, source, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::signer(admin)?;
    accounts::writable(feed_config)?;

    // The source must already be a genuine Pyth account carrying this feed id
    // before its address is stored, not merely at read time.
    {
        let source_data = source.try_borrow()?;
        validate_pyth_source(
            source.owner().as_array(),
            &source_data,
            &feed_id,
            min_verification_signatures,
        )?;
    }

    // The PDA check Anchor's `seeds`/`bump` would have generated. Without it,
    // any writable account could be passed as the config.
    let (expected, bump) = Address::find_program_address(&[FEED_CONFIG_SEED, &feed_id], program_id);
    if feed_config.address() != &expected {
        return Err(OptionsError::InvalidParams.into());
    }

    // Rent computed from the constant rather than `Rent::try_minimum_balance`.
    //
    // pinocchio 0.11.2 populates `Rent`'s single `lamports_per_byte` field from
    // the sysvar's *`lamports_per_byte_year`* (3480), while its arithmetic
    // assumes the threshold-multiplied value -- its own
    // `DEFAULT_LAMPORTS_PER_BYTE` is 6960. The helper therefore returns exactly
    // half the rent-exempt minimum, the CreateAccount CPI reports success, and
    // the transaction dies at the end on "insufficient funds for rent".
    //
    // Caught by `tests/pinocchio-oracle.ts`, and by nothing else: the 43 unit
    // tests in this crate are all pure logic and never execute the CPI.
    //
    // Using the constant means a chain that changed its rent parameters would
    // under-fund and fail loudly, which is the safe direction. It also drops a
    // syscall.
    let lamports = (ACCOUNT_STORAGE_OVERHEAD + FEED_CONFIG_LEN as u64)
        .checked_mul(LAMPORTS_PER_BYTE)
        .ok_or(OptionsError::MathOverflow)?;
    let bump_seed = [bump];
    let seeds = [
        Seed::from(FEED_CONFIG_SEED),
        Seed::from(&feed_id[..]),
        Seed::from(&bump_seed[..]),
    ];

    pinocchio_system::instructions::CreateAccount {
        from: payer,
        to: feed_config,
        lamports,
        space: FEED_CONFIG_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;

    let cfg = FeedConfig {
        admin: *admin.address().as_array(),
        feed_id,
        source: *source.address().as_array(),
        max_age_secs,
        min_verification_signatures,
        bump,
    };
    let mut data = feed_config.try_borrow_mut()?;
    cfg.store(&mut data)?;
    Ok(())
}

/// Repoint the config at a new Pyth price account for the same feed.
///
/// The feed id is deliberately not settable — repointing at a different asset
/// is the obvious attack. Rotating the *account* is what this exists for.
fn set_source(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [admin, feed_config, source, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::signer(admin)?;
    accounts::owned_by_program(feed_config, program_id)?;
    accounts::writable(feed_config)?;

    let mut data = feed_config.try_borrow_mut()?;
    let mut cfg = FeedConfig::load(&data)?;
    accounts::has_admin(&cfg, admin)?;

    // Rotating the address may not weaken the feed: the replacement must carry
    // the same immutable feed id and clear the configured signature floor.
    {
        let source_data = source.try_borrow()?;
        validate_pyth_source(
            source.owner().as_array(),
            &source_data,
            &cfg.feed_id,
            cfg.min_verification_signatures,
        )?;
    }

    cfg.source = *source.address().as_array();
    cfg.store(&mut data)?;
    Ok(())
}

fn set_admin(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    if args.len() < 32 {
        return Err(OptionsError::InvalidParams.into());
    }
    let mut new_admin = [0u8; 32];
    new_admin.copy_from_slice(&args[..32]);

    let [admin, feed_config, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::signer(admin)?;
    accounts::owned_by_program(feed_config, program_id)?;
    accounts::writable(feed_config)?;

    let mut data = feed_config.try_borrow_mut()?;
    let mut cfg = FeedConfig::load(&data)?;
    accounts::has_admin(&cfg, admin)?;
    cfg.admin = new_admin;
    cfg.store(&mut data)?;
    Ok(())
}

/// Read the current quote and return it as instruction return data.
fn preview_quote(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [feed_config, source, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::owned_by_program(feed_config, program_id)?;

    let cfg_data = feed_config.try_borrow()?;
    let cfg = FeedConfig::load(&cfg_data)?;

    let source_data = source.try_borrow()?;
    let now = Clock::get()?.unix_timestamp;
    let quote = read_quote(
        &cfg,
        source.address().as_array(),
        source.owner().as_array(),
        &source_data,
        now,
    )?;

    // Same wire shape as the Anchor variant's `PriceData::try_to_vec()`:
    // feed_id ++ price(i128) ++ decimals(u32) ++ timestamp(i64).
    let mut out = [0u8; 32 + 16 + 4 + 8];
    out[..32].copy_from_slice(&quote.feed_id);
    out[32..48].copy_from_slice(&quote.price.to_le_bytes());
    out[48..52].copy_from_slice(&quote.decimals.to_le_bytes());
    out[52..60].copy_from_slice(&quote.timestamp.to_le_bytes());
    pinocchio::cpi::set_return_data(&out);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anchor derives instruction discriminators from the method name. A
    /// mismatch means a client built against the Anchor IDL would silently fail
    /// to reach this program, so derive them rather than trust the literals.
    #[test]
    fn instruction_discriminators_match_anchor() {
        use sha2::{Digest, Sha256};
        let cases = [
            ("global:initialize_feed_config", ix::INITIALIZE_FEED_CONFIG),
            ("global:set_source", ix::SET_SOURCE),
            ("global:set_admin", ix::SET_ADMIN),
            ("global:preview_quote", ix::PREVIEW_QUOTE),
        ];
        for (preimage, expected) in cases {
            let hash = Sha256::digest(preimage.as_bytes());
            assert_eq!(hash[..8], expected, "{preimage}");
        }
    }

    /// The program id must match the Anchor build's `declare_id!`, or the PDAs
    /// derived by the two variants would not coincide.
    ///
    /// Compared against `oracle_adapter::ID` itself, not a transcribed literal.
    /// The literal form of this test passed while the two ids genuinely
    /// differed -- it only ever compared the constant to a copy of itself --
    /// and that mismatch silently skipped the whole on-validator suite.
    #[test]
    fn program_id_matches_the_anchor_variant() {
        assert_eq!(ID, oracle_adapter::ID.to_bytes());
    }
}
