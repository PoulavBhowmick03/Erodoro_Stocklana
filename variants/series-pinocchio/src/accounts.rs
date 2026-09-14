// SPDX-License-Identifier: Apache-2.0
//! The checks Anchor's `#[derive(Accounts)]` would have generated.
//!
//! This is the part of the port that carries risk. `series` is the only program
//! that holds collateral, and every constraint below is the difference between
//! an instruction that moves a holder's tokens and one that moves somebody
//! else's. `variants/ACCOUNT-CHECKS.md` maps each Anchor attribute to the
//! function here that replaces it.
//!
//! Two shapes recur and are worth naming once:
//!
//! - **`has_one = x`** compares a pubkey stored *in the account* against one
//!   the caller passed. It is what stops a series being presented alongside
//!   another series' vault. Every one of them is a separate call below,
//!   deliberately, so a missing check is a missing line rather than a missing
//!   argument.
//! - **`seeds = [..], bump = <stored>`** re-derives with the bump the account
//!   itself recorded — `create_program_address`, not `find_program_address`.
//!   Searching would accept an account at *some* valid bump; Anchor accepts it
//!   only at the one it was created with.

use {
    crate::{
        error::err,
        state::{SeriesConfig, SeriesStatus},
    },
    common::OptionsError,
    pinocchio::{account::AccountView, address::Address, error::ProgramError},
};

/// SPL Token and Token-2022. Collateral is Token-2022; P and N are deliberately
/// plain SPL so they trade anywhere with no extension handling.
pub const SPL_TOKEN_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_2022_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// A legacy SPL token account: mint(32) owner(32) amount(8) ... = 165.
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// A legacy SPL mint is exactly 82 bytes; a Token-2022 mint is at least that
/// before its extension TLV.
pub const MINT_BASE_LEN: usize = 82;

/// `Account<'info, T>`: owned by this program.
pub fn owned_by_program(account: &AccountView, program_id: &Address) -> Result<(), ProgramError> {
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

/// A pubkey the caller passed must equal one the program already knows.
pub fn key_is(account: &AccountView, expected: &[u8; 32]) -> Result<(), ProgramError> {
    if account.address().as_array() != expected {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(())
}

/// Every `has_one` on `SeriesConfig`, in one place.
///
/// Anchor spells these as five separate attributes and checks all of them. The
/// signature takes all five so a caller cannot quietly check three: adding an
/// account to the context without adding it here is a compile error, not a
/// silent gap.
pub fn series_has_one(
    config: &SeriesConfig,
    collateral_mint: &AccountView,
    collateral_vault: &AccountView,
    p_mint: &AccountView,
    n_mint: &AccountView,
) -> Result<(), ProgramError> {
    key_is(collateral_mint, &config.collateral_mint)?;
    key_is(collateral_vault, &config.collateral_vault)?;
    key_is(p_mint, &config.p_mint)?;
    key_is(n_mint, &config.n_mint)?;
    Ok(())
}

/// `has_one = oracle_adapter`, which only `settle` carries.
pub fn series_has_oracle(
    config: &SeriesConfig,
    oracle_adapter: &AccountView,
) -> Result<(), ProgramError> {
    key_is(oracle_adapter, &config.oracle_adapter)
}

/// `has_one = admin`.
pub fn series_has_admin(config: &SeriesConfig, admin: &AccountView) -> Result<(), ProgramError> {
    if &config.admin != admin.address().as_array() {
        return Err(err(OptionsError::Unauthorized));
    }
    Ok(())
}

/// `seeds = [..], bump = <stored>`, re-derived with the stored bump.
pub fn pda_with_bump(
    account: &AccountView,
    seeds: &[&[u8]],
    bump: u8,
    program_id: &Address,
) -> Result<(), ProgramError> {
    let mut full: [&[u8]; 6] = [&[], &[], &[], &[], &[], &[]];
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

/// The mint of an SPL or Token-2022 token account. Layout: mint(32) owner(32).
pub fn token_account_mint(account: &AccountView) -> Result<[u8; 32], ProgramError> {
    let owner = account.owner().as_array();
    if owner != &SPL_TOKEN_ID && owner != &SPL_TOKEN_2022_ID {
        return Err(ProgramError::IllegalOwner);
    }
    let data = account.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(err(OptionsError::InvalidParams));
    }
    let mut mint = [0u8; 32];
    mint.copy_from_slice(&data[..32]);
    Ok(mint)
}

/// The authority of a token account.
pub fn token_account_authority(account: &AccountView) -> Result<[u8; 32], ProgramError> {
    let owner = account.owner().as_array();
    if owner != &SPL_TOKEN_ID && owner != &SPL_TOKEN_2022_ID {
        return Err(ProgramError::IllegalOwner);
    }
    let data = account.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(err(OptionsError::InvalidParams));
    }
    let mut auth = [0u8; 32];
    auth.copy_from_slice(&data[32..64]);
    Ok(auth)
}

/// `token::mint = m` and, when given, `token::authority = a`.
///
/// `authority` is `None` wherever the Anchor build omits the constraint —
/// `split`'s receivers, for instance, are deliberately allowed to belong to
/// anyone, because a writer may want the claim tokens delivered elsewhere.
/// Copying that omission is as important as copying the checks.
pub fn token_account_is(
    account: &AccountView,
    mint: &[u8; 32],
    authority: Option<&[u8; 32]>,
) -> Result<(), ProgramError> {
    if &token_account_mint(account)? != mint {
        return Err(err(OptionsError::InvalidParams));
    }
    if let Some(a) = authority {
        if &token_account_authority(account)? != a {
            return Err(err(OptionsError::Unauthorized));
        }
    }
    Ok(())
}

/// A token account of either program with enough data to read, without any
/// mint or authority binding. This is what Anchor's bare `InterfaceAccount`
/// checks: owner plus length. Mint and authority bindings, where Anchor has
/// them, are separate calls so each check stays exactly as strict as the
/// attribute it replaces — no stricter.
pub fn token_account_program(account: &AccountView) -> Result<(), ProgramError> {
    let owner = account.owner().as_array();
    if owner != &SPL_TOKEN_ID && owner != &SPL_TOKEN_2022_ID {
        return Err(ProgramError::IllegalOwner);
    }
    if account.try_borrow()?.len() < TOKEN_ACCOUNT_LEN {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(())
}

/// `InterfaceAccount<'info, Mint>` — owned by a token program and long enough.
pub fn mint(account: &AccountView) -> Result<(), ProgramError> {
    let owner = account.owner().as_array();
    if owner != &SPL_TOKEN_ID && owner != &SPL_TOKEN_2022_ID {
        return Err(ProgramError::IllegalOwner);
    }
    if account.try_borrow()?.len() < MINT_BASE_LEN {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(())
}

/// `#[account(mint::token_program = p)]`.
pub fn mint_token_program(
    mint_account: &AccountView,
    token_program: &AccountView,
) -> Result<(), ProgramError> {
    if mint_account.owner() != token_program.address() {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(())
}

/// `Program<'info, T>`.
pub fn program(account: &AccountView, expected: &[u8; 32]) -> Result<(), ProgramError> {
    if account.address().as_array() != expected {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// The status gate, as the Anchor build words it.
///
/// Kept here rather than inline so the asymmetry stays visible: `Paused` blocks
/// splits and **not** merges, because a pause that trapped collateral would be
/// a pause that could steal it.
pub fn require_not_settled(config: &SeriesConfig) -> Result<(), ProgramError> {
    if config.status == SeriesStatus::Settled {
        return Err(err(OptionsError::SeriesClosed));
    }
    Ok(())
}
