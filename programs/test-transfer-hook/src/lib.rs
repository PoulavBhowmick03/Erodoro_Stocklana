// SPDX-License-Identifier: Apache-2.0
//! A Token-2022 transfer hook, for tests only.
//!
//! §9 of the implementation plan says the hook on TSLAx is "dormant, not
//! absent": `transferHook.programId` is `None` today, and the authority can
//! arm it at any time without redeploying the mint. On that day every vault
//! instruction that moves collateral either keeps working or starts failing,
//! and which one it is was decided months earlier by whether the transfer path
//! resolves hook accounts.
//!
//! This program exists so that question can be answered by a test instead of
//! by a deployment. It implements the minimum of
//! `spl-transfer-hook-interface` and does one extra thing: every execution
//! bumps a counter. A test that arms this hook on a mint and then runs the
//! full series lifecycle can assert both that the transfers succeeded *and*
//! that the hook actually ran — the second half matters, because a transfer
//! path that silently bypassed the hook would look identical from the
//! outside.
//!
//! Not an Anchor program. The interface's instruction discriminators come from
//! the SPL spec rather than Anchor's sighash scheme, so a plain program is
//! both smaller and a more faithful stand-in for whatever Backed would
//! actually arm.

#![allow(unexpected_cfgs)]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::instruction as system_instruction;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

solana_program::declare_id!("A7q6ebW3jMRzx8JDNSYKXpVNdfaE78EaTYCP5LxZFNXR");

/// Seeds of the counter this hook bumps on every transfer. One per mint, so a
/// test can attribute executions to the mint under test.
pub const COUNTER_SEED: &[u8] = b"counter";

/// Address of the counter for `mint`.
pub fn counter_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[COUNTER_SEED, mint.as_ref()], &id())
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    match TransferHookInstruction::unpack(input)? {
        TransferHookInstruction::Execute { amount } => execute(program_id, accounts, amount),
        TransferHookInstruction::InitializeExtraAccountMetaList { .. } => {
            initialize_extra_account_meta_list(program_id, accounts)
        }
        TransferHookInstruction::UpdateExtraAccountMetaList { .. } => {
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

/// Write the extra-account-meta list for a mint, and create the counter it
/// points at.
///
/// Accounts, in order: `[meta_list, mint, authority, system_program, payer,
/// counter]`. The trailing two are beyond what the interface prescribes; the
/// tests build this instruction directly, so the order is ours to fix.
///
/// The one extra account is the per-mint counter, resolved from its seeds so
/// the caller never has to know the address, and marked writable so `execute`
/// can bump it. This is deliberately the awkward case: a hook needing no extra
/// accounts would not exercise the resolution path at all, which is the part
/// of §9 most likely to be wrong.
fn initialize_extra_account_meta_list(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let meta_list = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let _system_program = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let counter = next_account_info(iter)?;

    if !authority.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let extras = [ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: COUNTER_SEED.to_vec(),
            },
            // The mint sits at index 1 of the Execute account list.
            Seed::AccountKey { index: 1 },
        ],
        false,
        true,
    )?];

    let (expected_list, list_bump) =
        Pubkey::find_program_address(&[b"extra-account-metas", mint.key.as_ref()], program_id);
    if expected_list != *meta_list.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let (expected_counter, counter_bump) = counter_address(mint.key);
    if expected_counter != *counter.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::get()?;

    let size = ExtraAccountMetaList::size_of(extras.len())?;
    solana_program::program::invoke_signed(
        &system_instruction::create_account(
            payer.key,
            meta_list.key,
            rent.minimum_balance(size),
            size as u64,
            program_id,
        ),
        &[payer.clone(), meta_list.clone()],
        &[&[b"extra-account-metas", mint.key.as_ref(), &[list_bump]]],
    )?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut meta_list.try_borrow_mut_data()?,
        &extras,
    )?;

    solana_program::program::invoke_signed(
        &system_instruction::create_account(
            payer.key,
            counter.key,
            rent.minimum_balance(8),
            8,
            program_id,
        ),
        &[payer.clone(), counter.clone()],
        &[&[COUNTER_SEED, mint.key.as_ref(), &[counter_bump]]],
    )?;
    Ok(())
}

/// Run on every `transfer_checked` once the hook is armed.
///
/// Bumps the per-mint counter. Creating it on first use keeps the test setup
/// to a single instruction.
fn execute(program_id: &Pubkey, accounts: &[AccountInfo], _amount: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let _source = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let _destination = next_account_info(iter)?;
    let _authority = next_account_info(iter)?;
    let _meta_list = next_account_info(iter)?;
    let counter = next_account_info(iter)?;

    let (expected, _bump) = counter_address(mint.key);
    if expected != *counter.key {
        return Err(ProgramError::InvalidSeeds);
    }
    // The counter is created by the test before any transfer runs; a hook that
    // allocated accounts mid-transfer would not resemble a real one.
    if counter.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let mut data = counter.try_borrow_mut_data()?;
    if data.len() < 8 {
        return Err(ProgramError::AccountDataTooSmall);
    }
    let current = u64::from_le_bytes(data[..8].try_into().unwrap());
    let next = current
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    data[..8].copy_from_slice(&next.to_le_bytes());
    Ok(())
}
