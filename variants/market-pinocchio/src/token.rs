// SPDX-License-Identifier: Apache-2.0
//! The two SPL instructions `market` sends: a legacy Token `Transfer`, and an
//! Associated Token Account `Create`.
//!
//! Both are pre-Anchor formats and neither is discriminator-hashed. `Transfer`
//! is tag `3` followed by a little-endian `u64`; ATA `Create` is a single `0`
//! byte. They are stable, versioned by program id rather than by position, and
//! small enough that rebuilding them costs nothing -- unlike the MagicBlock
//! payloads in [`crate::delegation`], which needed an equivalence test.
//!
//! `market` uses the legacy Token program deliberately: P and N are plain SPL
//! mints so they trade anywhere, and only the collateral in `series` carries
//! Token-2022 extensions.

use {
    crate::error::MarketError,
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::{invoke, invoke_signed, Seed, Signer},
        instruction::{InstructionAccount, InstructionView},
        ProgramResult,
    },
};

pub const TOKEN_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM_ID: [u8; 32] =
    pinocchio_pubkey::pubkey!("11111111111111111111111111111111");

/// `spl_token::instruction::TokenInstruction::Transfer`.
const TRANSFER_TAG: u8 = 3;

/// A legacy SPL `Transfer`, optionally signed by a PDA authority.
///
/// `signer_seeds` is empty for a deposit, where the trader signs, and carries
/// the market PDA's seeds for a withdrawal, where the vault authority is the
/// program itself.
pub fn transfer(
    token_program: &AccountView,
    from: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signer_seeds: &[Seed],
) -> ProgramResult {
    if token_program.address().as_array() != &TOKEN_PROGRAM_ID {
        return Err(MarketError::InvalidAmount.into());
    }

    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];

    let mut data = [0u8; 9];
    data[0] = TRANSFER_TAG;
    data[1..].copy_from_slice(&amount.to_le_bytes());

    let ix = InstructionView {
        program_id: &Address::new_from_array(TOKEN_PROGRAM_ID),
        accounts: &metas,
        data: &data,
    };
    let views = [from, to, authority];

    if signer_seeds.is_empty() {
        invoke(&ix, &views)
    } else {
        invoke_signed(&ix, &views, &[Signer::from(signer_seeds)])
    }
}

/// `spl_associated_token_account::instruction::AssociatedTokenAccountInstruction::Create`.
const ATA_CREATE_TAG: u8 = 0;

/// Create an associated token account for `owner` over `mint`.
///
/// The ATA program derives the address itself and fails if the account passed
/// is not the one it would derive, which is the same check Anchor's
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
) -> ProgramResult {
    if ata_program.address().as_array() != &ASSOCIATED_TOKEN_PROGRAM_ID {
        return Err(MarketError::InvalidAmount.into());
    }

    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(ata.address()),
        InstructionAccount::readonly(owner.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::readonly(system_program.address()),
        InstructionAccount::readonly(token_program.address()),
    ];

    let data = [ATA_CREATE_TAG];
    let ix = InstructionView {
        program_id: &Address::new_from_array(ASSOCIATED_TOKEN_PROGRAM_ID),
        accounts: &metas,
        data: &data,
    };
    let views = [payer, ata, owner, mint, system_program, token_program];
    invoke(&ix, &views)
}
