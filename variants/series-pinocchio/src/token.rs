// SPDX-License-Identifier: Apache-2.0
//! The classic SPL Token instructions this program sends, plus account
//! creation.
//!
//! P and N are deliberately plain SPL mints, so everything here is the
//! pre-Token-2022 encoding: single-byte tags, no extensions, no hooks. Each
//! builder is pure — instruction bytes plus metas — and asserted byte-equal to
//! `spl_token`'s own builders in `tests/token_wire.rs`. The invoke wrappers
//! are thin.
//!
//! Account creation goes through the system program (`pinocchio-system`) for
//! the config, settlement and mint accounts, and through the associated-token
//! program for the vault ATA.

use {
    crate::error::err,
    common::OptionsError,
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::{invoke_signed, Seed, Signer},
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
    },
    pinocchio_system::instructions::CreateAccount,
};

pub const TOKEN_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("11111111111111111111111111111111");

/// Lamports per byte-year and per-account overhead: the rent-exempt formula
/// every amount here is computed from.
pub fn rent_exempt(len: usize) -> u64 {
    (128 + len as u64) * 6960
}

/// Legacy SPL `MintTo`: tag 7 followed by the amount.
pub fn mint_to_data(amount: u64) -> [u8; 9] {
    let mut data = [0u8; 9];
    data[0] = 7;
    data[1..].copy_from_slice(&amount.to_le_bytes());
    data
}

/// Legacy SPL `Burn`: tag 8 followed by the amount.
pub fn burn_data(amount: u64) -> [u8; 9] {
    let mut data = [0u8; 9];
    data[0] = 8;
    data[1..].copy_from_slice(&amount.to_le_bytes());
    data
}

/// Legacy SPL `InitializeMint2`: tag 20, decimals, mint authority, and the
/// freeze authority as a `COption` — a lone zero byte for `None`, not padded.
///
/// This is the instruction Anchor's mint `init` emits (not tag 0: the v2 form
/// needs no rent sysvar account, which is why the client never passes one).
/// Anchor leaves the freeze authority unset unless the program names one;
/// this build does the same. Proven against an Anchor-created mint on a
/// validator in `tests/series-lifecycle.rs`.
pub fn initialize_mint_data(decimals: u8, mint_authority: &[u8; 32]) -> [u8; 35] {
    let mut data = [0u8; 35];
    data[0] = 20;
    data[1] = decimals;
    data[2..34].copy_from_slice(mint_authority);
    data[34] = 0; // COption::None freeze authority.
    data
}

/// Mint `amount` claim tokens, signed by the series PDA.
pub fn mint_to(
    token_program: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signer_seeds: &[Seed],
) -> Result<(), ProgramError> {
    if token_program.address().as_array() != &TOKEN_PROGRAM_ID {
        return Err(err(OptionsError::InvalidParams));
    }
    let data = mint_to_data(amount);
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let views = [mint, to, authority];
    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas,
        data: &data,
    };
    invoke_signed(&ix, &views, &[Signer::from(signer_seeds)])
}

/// Burn `amount` claim tokens, signed by the holder.
pub fn burn(
    token_program: &AccountView,
    mint: &AccountView,
    from: &AccountView,
    authority: &AccountView,
    amount: u64,
) -> Result<(), ProgramError> {
    if token_program.address().as_array() != &TOKEN_PROGRAM_ID {
        return Err(err(OptionsError::InvalidParams));
    }
    let data = burn_data(amount);
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::writable(mint.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let views = [from, mint, authority];
    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas,
        data: &data,
    };
    pinocchio::cpi::invoke(&ix, &views)
}

/// Initialize a freshly created mint: decimals from the collateral mint,
/// authority the series PDA, no freeze authority.
pub fn initialize_mint(
    token_program: &AccountView,
    mint: &AccountView,
    decimals: u8,
    mint_authority: &[u8; 32],
) -> Result<(), ProgramError> {
    if token_program.address().as_array() != &TOKEN_PROGRAM_ID {
        return Err(err(OptionsError::InvalidParams));
    }
    let data = initialize_mint_data(decimals, mint_authority);
    let metas = [InstructionAccount::writable(mint.address())];
    let views = [mint];
    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas,
        data: &data,
    };
    pinocchio::cpi::invoke(&ix, &views)
}

/// Create a program-owned account: system `CreateAccount` funded by `payer`.
///
/// Every account this program creates is a PDA, and the system program
/// requires the new account's signature — so its seeds always travel along.
/// Omitting them surfaces as a privilege escalation, not a missing signature.
pub fn create_account(
    payer: &AccountView,
    target: &AccountView,
    owner: &Address,
    len: usize,
    signer_seeds: &[Seed],
) -> Result<(), ProgramError> {
    CreateAccount {
        from: payer,
        to: target,
        lamports: rent_exempt(len),
        space: len as u64,
        owner,
    }
    .invoke_signed(&[Signer::from(signer_seeds)])
}

/// Create the collateral vault ATA through the associated-token program.
///
/// The ATA program derives the address itself and fails if the passed account
/// is not the one it would derive — the same check Anchor's
/// `associated_token::` constraints lean on.
#[allow(clippy::too_many_arguments)]
pub fn create_associated_token_account(
    ata_program: &AccountView,
    payer: &AccountView,
    ata: &AccountView,
    owner: &AccountView,
    mint: &AccountView,
    system_program: &AccountView,
    token_program: &AccountView,
) -> Result<(), ProgramError> {
    if ata_program.address().as_array() != &ASSOCIATED_TOKEN_PROGRAM_ID {
        return Err(err(OptionsError::InvalidParams));
    }
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(ata.address()),
        InstructionAccount::readonly(owner.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::readonly(system_program.address()),
        InstructionAccount::readonly(token_program.address()),
    ];
    let views = [payer, ata, owner, mint, system_program, token_program];
    let data = [0u8; 1];
    let ix = InstructionView {
        program_id: ata_program.address(),
        accounts: &metas,
        data: &data,
    };
    pinocchio::cpi::invoke(&ix, &views)
}

/// Token-account amount at the classic offset, bounds-checked.
pub fn token_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < 72 {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Token-account owner at the classic offset, bounds-checked.
pub fn token_owner(data: &[u8]) -> Result<[u8; 32], ProgramError> {
    if data.len() < 64 {
        return Err(err(OptionsError::InvalidParams));
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[32..64]);
    Ok(owner)
}

/// Mint supply and decimals at the classic offsets, bounds-checked.
pub fn mint_supply(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < 44 {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(u64::from_le_bytes(data[36..44].try_into().unwrap()))
}

pub fn mint_decimals(data: &[u8]) -> Result<u8, ProgramError> {
    if data.len() < 45 {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(data[44])
}
