// SPDX-License-Identifier: Apache-2.0
//! The CPI into `series::create_series`, hand-encoded.
//!
//! Anchor generates this from `series::cpi::accounts::CreateSeries`: the
//! account order, each account's signer and writable flags, and the
//! `sha256("global:create_series")[..8] ++ borsh(params)` data. All three have
//! to match byte for byte or the callee rejects the call -- and the flags in
//! particular are derived from the *callee's* declared context, not from how
//! the caller happens to hold the account.
//!
//! The order below is `series::CreateSeries`' field order, which is the only
//! thing that defines it.

use {
    crate::policy::{CreateSeriesParams, CREATE_SERIES_PARAMS_LEN},
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::{invoke_signed, Seed, Signer},
        instruction::{InstructionAccount, InstructionView},
        ProgramResult,
    },
};

pub const SERIES_ID: Address = Address::new_from_array(pinocchio_pubkey::pubkey!(
    "AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9"
));

/// `sha256("global:create_series")[..8]`, derived in the conformance tests.
pub const CREATE_SERIES_DISC: [u8; 8] = [181, 9, 52, 120, 197, 221, 42, 142];

/// Number of accounts `series::create_series` declares.
pub const ACCOUNT_COUNT: usize = 14;

/// The accounts, in the callee's declared order.
pub struct Accounts<'a> {
    pub payer: &'a AccountView,
    pub factory_authority: &'a AccountView,
    pub admin: &'a AccountView,
    pub series: &'a AccountView,
    pub collateral_mint: &'a AccountView,
    pub collateral_vault: &'a AccountView,
    pub oracle_adapter: &'a AccountView,
    pub p_mint: &'a AccountView,
    pub n_mint: &'a AccountView,
    pub fee_recipient: &'a AccountView,
    pub collateral_token_program: &'a AccountView,
    pub token_program: &'a AccountView,
    pub associated_token_program: &'a AccountView,
    pub system_program: &'a AccountView,
}

/// Drive `series::create_series`, signed by the factory PDA.
///
/// `factory_authority` is a signer here and nowhere else: the series program
/// takes it as a PDA seed precisely so that a series created through the
/// factory occupies an address nobody else can squat.
pub fn create_series(
    accounts: Accounts<'_>,
    params: &CreateSeriesParams,
    factory_seeds: &[Seed],
) -> ProgramResult {
    // Flags come from `series::CreateSeries`: `payer` is `mut` + `Signer`,
    // `factory_authority` is `Signer` without `mut`, and the four `init`
    // accounts are writable.
    let metas: [InstructionAccount; ACCOUNT_COUNT] = [
        InstructionAccount::writable_signer(accounts.payer.address()),
        InstructionAccount::readonly_signer(accounts.factory_authority.address()),
        InstructionAccount::readonly(accounts.admin.address()),
        InstructionAccount::writable(accounts.series.address()),
        InstructionAccount::readonly(accounts.collateral_mint.address()),
        InstructionAccount::writable(accounts.collateral_vault.address()),
        InstructionAccount::readonly(accounts.oracle_adapter.address()),
        InstructionAccount::writable(accounts.p_mint.address()),
        InstructionAccount::writable(accounts.n_mint.address()),
        InstructionAccount::readonly(accounts.fee_recipient.address()),
        InstructionAccount::readonly(accounts.collateral_token_program.address()),
        InstructionAccount::readonly(accounts.token_program.address()),
        InstructionAccount::readonly(accounts.associated_token_program.address()),
        InstructionAccount::readonly(accounts.system_program.address()),
    ];

    let mut data = [0u8; 8 + CREATE_SERIES_PARAMS_LEN];
    data[..8].copy_from_slice(&CREATE_SERIES_DISC);
    data[8..].copy_from_slice(&params.encode());

    let instruction = InstructionView {
        program_id: &SERIES_ID,
        accounts: &metas,
        data: &data,
    };

    let views: [&AccountView; ACCOUNT_COUNT] = [
        accounts.payer,
        accounts.factory_authority,
        accounts.admin,
        accounts.series,
        accounts.collateral_mint,
        accounts.collateral_vault,
        accounts.oracle_adapter,
        accounts.p_mint,
        accounts.n_mint,
        accounts.fee_recipient,
        accounts.collateral_token_program,
        accounts.token_program,
        accounts.associated_token_program,
        accounts.system_program,
    ];

    invoke_signed(&instruction, &views, &[Signer::from(factory_seeds)])
}
