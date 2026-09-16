// SPDX-License-Identifier: Apache-2.0
//! Option factory — Pinocchio variant.
//!
//! Semantically identical to `programs/factory` (the Anchor build): same
//! program id, same account layouts, same instruction encoding, same error
//! codes, same events. It exists because deploy rent is `(bytes + 173) * 6960`
//! lamports and nothing else, so the framework is a measurable line item.
//!
//! # What changes without Anchor
//!
//! Anchor's `#[derive(Accounts)]` generates the ownership, signer, writable,
//! PDA and `has_one` checks. None of that exists here, so every one of them is
//! written out in [`accounts`]. That is the real cost of this variant: those
//! checks *are* the security model, and here they are hand-maintained rather
//! than derived. The factory holds no collateral, which is why it is the second
//! program ported rather than the last.
//!
//! Instruction encoding matches Anchor's: an 8-byte
//! `sha256("global:<name>")[..8]` discriminator followed by borsh-encoded
//! arguments, all of which are fixed width here.

#![cfg_attr(not(test), no_std)]
// The entrypoint macros emit `cfg(target_os = "solana")`, which the host
// toolchain does not know about.
#![allow(unexpected_cfgs)]

pub mod error;
pub mod events;
pub mod policy;
pub mod series_cpi;
pub mod state;

use {
    error::OptionsError,
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::{Seed, Signer},
        error::ProgramError,
        sysvars::{clock::Clock, Sysvar},
        ProgramResult,
    },
    policy::{validate_policy, CreateSeriesParams},
    state::{
        Approval, FactoryState, SeriesRecord, APPROVAL_LEN, COLLATERAL_SEED, FACTORY_SEED,
        FACTORY_STATE_LEN, ORACLE_SEED, RECORD_SEED, SERIES_RECORD_LEN,
    },
};

pinocchio_pubkey::declare_id!("CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ");

/// Lamports per byte for a rent-exempt account: `lamports_per_byte_year`
/// (3480) times the two-year exemption threshold.
const LAMPORTS_PER_BYTE: u64 = 6960;
/// The runtime's per-account storage overhead, charged on top of the data.
const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

/// `oracle_adapter`'s program id, and the discriminator of the `FeedConfig`
/// accounts it owns. Anchor's `Account<'info, FeedConfig>` checks both; here
/// they are checked by hand in [`accounts::feed_config`].
pub const ORACLE_ADAPTER_ID: Address = Address::new_from_array(pinocchio_pubkey::pubkey!(
    "FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz"
));
pub const FEED_CONFIG_DISC: [u8; 8] = [75, 97, 12, 15, 89, 221, 78, 71];

/// The two token programs an `InterfaceAccount<'info, Mint>` will accept.
pub const SPL_TOKEN_ID: Address = Address::new_from_array(pinocchio_pubkey::pubkey!(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
));
pub const SPL_TOKEN_2022_ID: Address = Address::new_from_array(pinocchio_pubkey::pubkey!(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
));
/// A legacy SPL mint is exactly 82 bytes; a Token-2022 mint is at least that
/// before its extension TLV.
pub const MINT_BASE_LEN: usize = 82;

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
    pub const INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
    pub const SET_ADMIN: [u8; 8] = [251, 163, 0, 52, 91, 194, 187, 92];
    pub const PAUSE_CREATION: [u8; 8] = [112, 176, 102, 168, 34, 18, 236, 95];
    pub const UNPAUSE_CREATION: [u8; 8] = [36, 195, 175, 219, 15, 149, 147, 202];
    pub const APPROVE_ORACLE: [u8; 8] = [199, 50, 54, 147, 30, 156, 249, 116];
    pub const REVOKE_ORACLE: [u8; 8] = [244, 253, 191, 174, 58, 179, 203, 48];
    pub const APPROVE_COLLATERAL: [u8; 8] = [193, 159, 219, 221, 83, 229, 203, 88];
    pub const REVOKE_COLLATERAL: [u8; 8] = [102, 218, 189, 142, 238, 147, 97, 152];
    pub const CREATE_SERIES: [u8; 8] = [181, 9, 52, 120, 197, 221, 42, 142];
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
        ix::INITIALIZE => initialize(program_id, accounts),
        ix::SET_ADMIN => set_admin(program_id, accounts, args),
        ix::PAUSE_CREATION => set_paused(program_id, accounts, true),
        ix::UNPAUSE_CREATION => set_paused(program_id, accounts, false),
        ix::APPROVE_ORACLE => approve_oracle(program_id, accounts),
        ix::REVOKE_ORACLE => revoke_approval(program_id, accounts, ORACLE_SEED),
        ix::APPROVE_COLLATERAL => approve_collateral(program_id, accounts),
        ix::REVOKE_COLLATERAL => revoke_approval(program_id, accounts, COLLATERAL_SEED),
        ix::CREATE_SERIES => create_series(program_id, accounts, args),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The checks Anchor would have generated, written once and shared.
mod accounts {
    use super::*;

    /// `Account<'info, T>`: owned by this program.
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

    /// `has_one = admin`.
    pub fn has_admin(state: &FactoryState, admin: &AccountView) -> Result<(), ProgramError> {
        if &state.admin != admin.address().as_array() {
            return Err(OptionsError::Unauthorized.into());
        }
        Ok(())
    }

    /// `seeds = [..], bump = <stored>`. Anchor re-derives with the stored bump
    /// and compares; so does this. Using the stored bump rather than searching
    /// is what makes it `create_program_address` and not `find`.
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

    /// `Account<'info, FeedConfig>` from the oracle adapter: owned by that
    /// program, and carrying its discriminator.
    pub fn feed_config(account: &AccountView) -> Result<(), ProgramError> {
        if account.owner() != &ORACLE_ADAPTER_ID {
            return Err(ProgramError::IllegalOwner);
        }
        let data = account.try_borrow()?;
        if data.len() < 8 || data[..8] != FEED_CONFIG_DISC {
            return Err(OptionsError::InvalidParams.into());
        }
        Ok(())
    }

    /// `InterfaceAccount<'info, Mint>`: owned by one of the two token programs
    /// and long enough to be a mint. Anchor deserializes the whole thing; the
    /// factory never reads a field, so length and ownership are the parts that
    /// carry weight.
    pub fn mint(account: &AccountView) -> Result<(), ProgramError> {
        let owner = account.owner();
        if owner != &SPL_TOKEN_ID && owner != &SPL_TOKEN_2022_ID {
            return Err(ProgramError::IllegalOwner);
        }
        if account.try_borrow()?.len() < MINT_BASE_LEN {
            return Err(OptionsError::InvalidParams.into());
        }
        Ok(())
    }

    /// `#[account(mint::token_program = p)]`.
    pub fn mint_token_program(
        mint_account: &AccountView,
        token_program: &AccountView,
    ) -> Result<(), ProgramError> {
        if mint_account.owner() != token_program.address() {
            return Err(OptionsError::InvalidParams.into());
        }
        Ok(())
    }

    /// `Program<'info, T>`.
    pub fn program(account: &AccountView, expected: &Address) -> Result<(), ProgramError> {
        if account.address() != expected {
            return Err(ProgramError::IncorrectProgramId);
        }
        Ok(())
    }
}

/// Rent-exempt minimum for `len` bytes of data.
fn rent_exempt(len: usize) -> u64 {
    (ACCOUNT_STORAGE_OVERHEAD + len as u64) * LAMPORTS_PER_BYTE
}

/// `init`: create a PDA this program owns, funded by `payer`.
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

fn initialize(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, admin, factory, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::signer(admin)?;
    accounts::writable(factory)?;

    let (expected, bump) = Address::find_program_address(&[FACTORY_SEED], program_id);
    if factory.address() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }

    let bump_seed = [bump];
    create_pda(
        payer,
        factory,
        &[Seed::from(FACTORY_SEED), Seed::from(&bump_seed[..])],
        FACTORY_STATE_LEN,
        program_id,
    )?;

    let mut data = factory.try_borrow_mut()?;
    FactoryState {
        admin: *admin.address().as_array(),
        paused: false,
        series_count: 0,
        bump,
    }
    .store(&mut data)?;
    Ok(())
}

/// Load the factory state after the checks `AdminOnly` would have generated.
fn load_admin_only<'a>(
    program_id: &Address,
    admin: &AccountView,
    factory: &'a AccountView,
) -> Result<FactoryState, ProgramError> {
    accounts::signer(admin)?;
    accounts::owned_by_program(factory, program_id)?;
    let state = {
        let data = factory.try_borrow()?;
        FactoryState::load(&data)?
    };
    accounts::pda_with_bump(factory, &[FACTORY_SEED], state.bump, program_id)?;
    accounts::has_admin(&state, admin)?;
    Ok(state)
}

fn set_admin(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [admin, factory, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if args.len() < 32 {
        return Err(OptionsError::InvalidParams.into());
    }
    accounts::writable(factory)?;
    let mut state = load_admin_only(program_id, admin, factory)?;

    let mut new_admin = [0u8; 32];
    new_admin.copy_from_slice(&args[..32]);
    state.admin = new_admin;

    let mut data = factory.try_borrow_mut()?;
    state.store(&mut data)?;
    Ok(())
}

fn set_paused(program_id: &Address, accounts: &mut [AccountView], paused: bool) -> ProgramResult {
    let [admin, factory, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::writable(factory)?;
    let mut state = load_admin_only(program_id, admin, factory)?;
    state.paused = paused;

    let mut data = factory.try_borrow_mut()?;
    state.store(&mut data)?;
    Ok(())
}

/// `approve_oracle` and `approve_collateral` differ only in which account is
/// vouched for and which seed prefix binds the approval to it.
fn approve(
    program_id: &Address,
    payer: &AccountView,
    admin: &AccountView,
    factory: &AccountView,
    target: &AccountView,
    approval: &mut AccountView,
    seed_prefix: &'static [u8],
) -> ProgramResult {
    accounts::signer(payer)?;
    accounts::writable(payer)?;
    // The factory is read, not written, by either approve path -- `#[account]`
    // without `mut` -- so only the admin binding is checked here.
    load_admin_only(program_id, admin, factory)?;
    accounts::writable(approval)?;

    let target_key = *target.address().as_array();
    let (expected, bump) = Address::find_program_address(&[seed_prefix, &target_key], program_id);
    if approval.address() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }

    let bump_seed = [bump];
    create_pda(
        payer,
        approval,
        &[
            Seed::from(seed_prefix),
            Seed::from(&target_key[..]),
            Seed::from(&bump_seed[..]),
        ],
        APPROVAL_LEN,
        program_id,
    )?;

    let mut data = approval.try_borrow_mut()?;
    Approval {
        target: target_key,
        bump,
    }
    .store(&mut data)?;
    Ok(())
}

fn approve_oracle(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, admin, factory, feed_config, approval, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::feed_config(feed_config)?;
    approve(
        program_id,
        payer,
        admin,
        factory,
        feed_config,
        approval,
        ORACLE_SEED,
    )?;
    events::oracle_approved(feed_config.address().as_array());
    Ok(())
}

fn approve_collateral(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, admin, factory, collateral_mint, approval, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    accounts::mint(collateral_mint)?;
    approve(
        program_id,
        payer,
        admin,
        factory,
        collateral_mint,
        approval,
        COLLATERAL_SEED,
    )?;
    events::collateral_approved(collateral_mint.address().as_array());
    Ok(())
}

/// `revoke_oracle` and `revoke_collateral`: closing the approval *is* the
/// revocation, and the seeds are derived from the target the approval names
/// rather than from an account the caller passes -- so a caller cannot close
/// one approval by presenting another's target.
fn revoke_approval(
    program_id: &Address,
    accounts: &mut [AccountView],
    seed_prefix: &'static [u8],
) -> ProgramResult {
    let [admin, factory, rent_recipient, approval, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    load_admin_only(program_id, admin, factory)?;
    accounts::writable(rent_recipient)?;
    accounts::owned_by_program(approval, program_id)?;
    accounts::writable(approval)?;

    let record = {
        let data = approval.try_borrow()?;
        Approval::load(&data)?
    };
    accounts::pda_with_bump(
        approval,
        &[seed_prefix, &record.target],
        record.bump,
        program_id,
    )?;

    // Anchor's `close = rent_recipient`: move the lamports, then zero the
    // account's length and owner.
    let lamports = approval.lamports();
    let credited = rent_recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(OptionsError::MathOverflow)?;
    rent_recipient.set_lamports(credited);
    approval.set_lamports(0);
    approval.close()?;

    if seed_prefix == ORACLE_SEED {
        events::oracle_revoked(&record.target);
    } else {
        events::collateral_revoked(&record.target);
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn create_series(program_id: &Address, accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let [payer, admin, factory, series_admin, oracle_approval, collateral_approval, feed_config, collateral_mint, series, collateral_vault, p_mint, n_mint, fee_recipient, record, series_program, collateral_token_program, token_program, associated_token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let params = CreateSeriesParams::decode(args)?;

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::writable(factory)?;
    let mut state = load_admin_only(program_id, admin, factory)?;

    if state.paused {
        return Err(OptionsError::CreationPaused.into());
    }
    let now = Clock::get()?.unix_timestamp;
    validate_policy(&params, now)?;

    // The allowlist entries. Their seeds tie them to the feed and the mint, so
    // their mere existence at the right address is the approval -- exactly as
    // in the Anchor build, where the `seeds` constraint carries the whole
    // check and nothing reads `target`.
    accounts::feed_config(feed_config)?;
    accounts::owned_by_program(oracle_approval, program_id)?;
    let oracle_record = {
        let data = oracle_approval.try_borrow()?;
        Approval::load(&data)?
    };
    accounts::pda_with_bump(
        oracle_approval,
        &[ORACLE_SEED, feed_config.address().as_array()],
        oracle_record.bump,
        program_id,
    )?;

    accounts::mint(collateral_mint)?;
    accounts::mint_token_program(collateral_mint, collateral_token_program)?;
    accounts::owned_by_program(collateral_approval, program_id)?;
    let collateral_record = {
        let data = collateral_approval.try_borrow()?;
        Approval::load(&data)?
    };
    accounts::pda_with_bump(
        collateral_approval,
        &[COLLATERAL_SEED, collateral_mint.address().as_array()],
        collateral_record.bump,
        program_id,
    )?;

    accounts::program(series_program, &series_cpi::SERIES_ID)?;
    accounts::writable(series)?;
    accounts::writable(collateral_vault)?;
    accounts::writable(p_mint)?;
    accounts::writable(n_mint)?;
    accounts::writable(record)?;

    // The CPI is signed by the factory PDA, which is what the series program
    // records as the creator.
    let factory_bump = [state.bump];
    series_cpi::create_series(
        series_cpi::Accounts {
            payer,
            factory_authority: factory,
            admin: series_admin,
            series,
            collateral_mint,
            collateral_vault,
            oracle_adapter: feed_config,
            p_mint,
            n_mint,
            fee_recipient,
            collateral_token_program,
            token_program,
            associated_token_program,
            system_program,
        },
        &params,
        &[Seed::from(FACTORY_SEED), Seed::from(&factory_bump[..])],
    )?;

    let index = state.series_count;
    state.series_count = index.checked_add(1).ok_or(OptionsError::MathOverflow)?;
    {
        let mut data = factory.try_borrow_mut()?;
        state.store(&mut data)?;
    }

    let series_key = *series.address().as_array();
    let (expected_record, record_bump) =
        Address::find_program_address(&[RECORD_SEED, &series_key], program_id);
    if record.address() != &expected_record {
        return Err(ProgramError::InvalidSeeds);
    }
    let record_bump_seed = [record_bump];
    create_pda(
        payer,
        record,
        &[
            Seed::from(RECORD_SEED),
            Seed::from(&series_key[..]),
            Seed::from(&record_bump_seed[..]),
        ],
        SERIES_RECORD_LEN,
        program_id,
    )?;

    let entry = SeriesRecord {
        series: series_key,
        collateral_mint: *collateral_mint.address().as_array(),
        feed_config: *feed_config.address().as_array(),
        strike: params.strike,
        maturity_ts: params.maturity_ts,
        price_decimals: params.price_decimals,
        index,
        bump: record_bump,
    };
    {
        let mut data = record.try_borrow_mut()?;
        entry.store(&mut data)?;
    }

    events::series_registered(&entry);
    Ok(())
}

// --- The test suite -------------------------------------------------------
//
// `tests/` is compiled into this crate rather than as separate integration
// crates. Cargo only enables `lto` for a unit whose crate types can all be
// linked with it, and an rlib cannot, so `crate-type = ["cdylib", "lib"]`
// made `lto = "fat"` a silent no-op. The artifact is `cdylib`-only now, so
// cargo builds no rlib for the suite to link against and the suite is included
// here, with `autotests = false` keeping cargo from also building it as
// integration-test binaries.
//
// `extern crate self as factory_pinocchio` keeps every existing `factory_pinocchio::`
// path in those files resolving unchanged.
#[cfg(test)]
extern crate self as factory_pinocchio;

#[cfg(test)]
#[path = "../tests/conformance.rs"]
mod conformance;
