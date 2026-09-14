// SPDX-License-Identifier: Apache-2.0
//! Token-2022 `transfer_checked`, hook-aware, Pinocchio-native.
//!
//! This replicates `spl_token_2022::onchain::invoke_transfer_checked`
//! byte-for-byte: the `transfer_checked` discriminator and payload, the
//! multisig-authority branch, the mint-TLV transfer-hook lookup, the
//! validation-state PDA, `ExtraAccountMetaList` resolution with
//! de-escalation, and the trailing program id.
//!
//! Why it exists rather than calling through `spl-token-2022`: that crate's
//! `onchain` helper takes `solana_account_info::AccountInfo`, and linking the
//! crate pulls the processor and the full extension set into the binary. The
//! series program needs exactly one of its functions. What it does *not*
//! replicate is anything versioned by position — every constant below is
//! asserted against the SPL crates in `tests/transfer_wire.rs`, so an upstream
//! renumber fails a test instead of silently mistargeting.
//!
//! # Structure
//!
//! [`plan_transfer_checked`] is pure: keys, flags and byte slices in, an
//! instruction payload plus account metas out. It runs on the host in tests,
//! where the differential suite drives it against SPL's own builders.
//! [`invoke_transfer_checked`] is the thin on-chain wrapper that borrows the
//! accounts, runs the plan, maps each planned meta back to its `AccountView`
//! and invokes.
//!
//! # Accepted divergences
//!
//! * A malformed hook list or multisig account fails with this module's own
//!   codes rather than SPL's `AccountResolutionError` numbers. The transaction
//!   still fails closed; only the number differs, and only on inputs no honest
//!   client ever sends.
//! * Resolution state is stack-resident with hard caps ([`MAX_CPI_ACCOUNTS`]).
//!   A hook list longer than the cap fails instead of overflowing the frame.

use {
    crate::error::err,
    common::OptionsError,
    pinocchio::{
        account::{AccountView, Ref},
        address::Address,
        cpi::{invoke_signed_with_bounds, Seed, Signer},
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
    },
};

/// `spl_token_2022::instruction::TokenInstruction::TransferChecked`.
pub const TRANSFER_CHECKED_TAG: u8 = 12;

/// `sha256("spl-transfer-hook-interface:execute")[..8]`, the discriminator the
/// execute instruction — and therefore every `InstructionData` seed — is read
/// against. Asserted against SPL in `tests/transfer_wire.rs`.
pub const EXECUTE_DISC: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];

/// Token-2022 mint base state length before the extension TLV.
pub const MINT_BASE_LEN: usize = 82;
/// `spl_token_2022::state::Multisig::LEN`.
pub const MULTISIG_LEN: usize = 355;

/// Hard cap on one transfer CPI's account list: 4 base accounts plus up to 16
/// hook or multisig extras. The stack frame is 4 KiB and every account costs
/// three resident arrays, so the cap is what keeps the frame inside it; a
/// hook list longer than this fails closed rather than overflowing the frame.
/// Sixteen covers an 11-member multisig plus hook extras simultaneously, far
/// beyond any deployed hook list.
pub const MAX_CPI_ACCOUNTS: usize = 20;

/// One planned CPI account: the key plus the flags the callee sees.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlannedMeta {
    pub key: [u8; 32],
    pub is_signer: bool,
    pub is_writable: bool,
}

/// The output of [`plan_transfer_checked`]: instruction bytes plus metas.
pub struct TransferPlan {
    pub data: [u8; 10],
    pub metas: [PlannedMeta; MAX_CPI_ACCOUNTS],
    pub len: usize,
}

impl TransferPlan {
    fn push(&mut self, meta: PlannedMeta) -> Result<(), ProgramError> {
        if self.len >= MAX_CPI_ACCOUNTS {
            return Err(err(OptionsError::InvalidParams));
        }
        self.metas[self.len] = meta;
        self.len += 1;
        Ok(())
    }

    /// SPL's `de_escalate_account_meta`: a resolved account must not gain
    /// signer/writable privileges it does not already carry in this
    /// instruction.
    fn de_escalate(&mut self, meta: &mut PlannedMeta) {
        let mut signer = false;
        let mut writable = false;
        let mut found = false;
        for existing in self.metas[..self.len].iter() {
            if existing.key == meta.key {
                found = true;
                signer |= existing.is_signer;
                writable |= existing.is_writable;
            }
        }
        if found {
            if !signer {
                meta.is_signer = false;
            }
            if !writable {
                meta.is_writable = false;
            }
        }
    }
}

/// An account the caller passes through: key plus borrowed data.
///
/// The wrapper borrows every account it is given up front, mirroring how SPL
/// holds `Ref`s for the whole resolution. Data is only *read* for the mint,
/// the authority and whichever accounts seeds actually reference.
pub struct ProvidedAccount<'a> {
    pub key: &'a [u8; 32],
    pub data: &'a [u8],
}

/// SPL `AccountResolutionError` codes used on this path, replicated so a
/// failing resolution surfaces the same number SPL would have produced. Each
/// is asserted against the SPL enum in `tests/transfer_wire.rs`.
mod resolution_code {
    pub const INCORRECT_ACCOUNT: u32 = 2_724_315_840;
    pub const INVALID_BYTES_FOR_SEED: u32 = 2_724_315_840 + 9;
    pub const INSTRUCTION_DATA_TOO_SMALL: u32 = 2_724_315_840 + 11;
    pub const ACCOUNT_NOT_FOUND: u32 = 2_724_315_840 + 12;
    pub const ACCOUNT_DATA_NOT_FOUND: u32 = 2_724_315_840 + 14;
    pub const ACCOUNT_DATA_TOO_SMALL: u32 = 2_724_315_840 + 15;
}

/// SPL `TransferHookError::IncorrectAccount`, for a hook program id or
/// validation state the caller did not pass.
pub const TRANSFER_HOOK_INCORRECT_ACCOUNT: u32 = 2_110_272_652;

fn resolution_error(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

/// Read the `TransferHook` extension off Token-2022 mint bytes.
///
/// Returns the hook program id, or `None` when the extension is absent or
/// unset. The extension value is 64 bytes — hook authority plus program id —
/// and only the program id decides. A truncated base state or a malformed TLV
/// fails closed.
pub fn transfer_hook_program_id(mint_data: &[u8]) -> Result<Option<[u8; 32]>, ProgramError> {
    const TRANSFER_HOOK_TYPE: u16 = 14;
    const TRANSFER_HOOK_LEN: usize = 64;
    let tlv = mint_tlv(mint_data)?;
    let mut at = 0;
    while at < tlv.len() {
        let ty = read_u16(tlv, at)?;
        let len = read_u16(tlv, at + 2)? as usize;
        let start = at + 4;
        let end = start
            .checked_add(len)
            .ok_or(ProgramError::InvalidAccountData)?;
        if end > tlv.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        if ty == TRANSFER_HOOK_TYPE {
            if len != TRANSFER_HOOK_LEN {
                return Err(ProgramError::InvalidAccountData);
            }
            let mut program_id = [0u8; 32];
            program_id.copy_from_slice(&tlv[start + 32..end]);
            return Ok(if program_id == [0u8; 32] {
                None
            } else {
                Some(program_id)
            });
        }
        at = end;
    }
    Ok(None)
}

/// The `scaledUiAmount` triple off Token-2022 mint bytes: current multiplier,
/// scheduled multiplier and its effective timestamp, as stored.
///
/// Field order is authority(32), multiplier(8), effective-timestamp(8),
/// new-multiplier(8) — timestamp before value, as the struct declares.
///
/// A mint without the extension reads as the identity triple rather than
/// failing, so the same path serves plain SPL and extension-less Token-2022.
pub fn scaled_ui_amount(mint_data: &[u8]) -> Result<(f64, f64, i64), ProgramError> {
    const SCALED_UI_AMOUNT_TYPE: u16 = 25;
    const CONFIG_LEN: usize = 32 + 8 + 8 + 8;
    let tlv = mint_tlv(mint_data)?;
    let mut at = 0;
    while at < tlv.len() {
        let ty = read_u16(tlv, at)?;
        let len = read_u16(tlv, at + 2)? as usize;
        let start = at + 4;
        let end = start
            .checked_add(len)
            .ok_or(ProgramError::InvalidAccountData)?;
        if end > tlv.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        if ty == SCALED_UI_AMOUNT_TYPE {
            if len != CONFIG_LEN {
                return Err(ProgramError::InvalidAccountData);
            }
            let body = &tlv[start..end];
            let current = f64::from_le_bytes(body[32..40].try_into().unwrap());
            let new_ts = i64::from_le_bytes(body[40..48].try_into().unwrap());
            let new = f64::from_le_bytes(body[48..56].try_into().unwrap());
            return Ok((current, new, new_ts));
        }
        at = end;
    }
    Ok((1.0, 1.0, 0))
}

/// The extension TLV of a Token-2022 mint account.
///
/// Mirrors `StateWithExtensions::<Mint>::unpack` field for field, because the
/// layout is not what a first guess says: a base state smaller than an
/// `Account` is zero-padded so the account-type byte sits at a fixed offset,
/// and any account with extensions is at least 165 bytes:
///
/// ```text
/// base(82) ++ padding(83 zeroes) ++ type(1) ++ tlv...
/// ```
///
/// A bare 82-byte base carries no extensions. Anything else short of the
/// padded shape, non-zero padding, a non-mint type, or an uninitialized base
/// fails — in the same order SPL checks, so the same inputs fail on both
/// builds.
fn mint_tlv(mint_data: &[u8]) -> Result<&[u8], ProgramError> {
    const BASE_ACCOUNT_LEN: usize = 165;
    if mint_data.len() == MULTISIG_LEN || mint_data.len() < MINT_BASE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    // `unpack_coption_key` accepts only the None/Some tags.
    let coption_tag = |at: usize| {
        let tag = u32::from_le_bytes([
            mint_data[at],
            mint_data[at + 1],
            mint_data[at + 2],
            mint_data[at + 3],
        ]);
        tag == 0 || tag == 1
    };
    if !coption_tag(0) || !coption_tag(46) {
        return Err(ProgramError::InvalidAccountData);
    }
    match mint_data[45] {
        1 => {}
        0 => return Err(ProgramError::UninitializedAccount),
        _ => return Err(ProgramError::InvalidAccountData),
    }
    if mint_data.len() == MINT_BASE_LEN {
        return Ok(&[]);
    }
    let rest = &mint_data[MINT_BASE_LEN..];
    let pad = BASE_ACCOUNT_LEN - MINT_BASE_LEN;
    if rest.len() < pad + 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    if rest[..pad].iter().any(|byte| *byte != 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    // Account type 1 is a mint; anything else is not a mint at all.
    if rest[pad] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(&rest[pad + 1..])
}

fn read_u16(data: &[u8], at: usize) -> Result<u16, ProgramError> {
    if data.len() < at + 2 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u16::from_le_bytes([data[at], data[at + 1]]))
}

/// Whether the authority is a multisig account: owned by the token program
/// with exactly a multisig's data length.
fn is_multisig(authority_data: &[u8], authority_owner: &[u8; 32], token_program: &[u8; 32]) -> bool {
    authority_owner == token_program && authority_data.len() == MULTISIG_LEN
}

/// The member keys of a multisig account: `m u8, n u8, initialized u8`, then
/// eleven 32-byte keys. Returns the full eleven plus the active count.
fn multisig_signers(authority_data: &[u8]) -> Result<(&[[u8; 32]], usize), ProgramError> {
    if authority_data.len() != MULTISIG_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let n = authority_data[1] as usize;
    if n == 0 || n > 11 {
        return Err(ProgramError::InvalidAccountData);
    }
    // SAFETY: length checked above; 3 + 11 * 32 == MULTISIG_LEN.
    let signers = unsafe {
        let ptr = authority_data.as_ptr().add(3) as *const [u8; 32];
        core::slice::from_raw_parts(ptr, 11)
    };
    Ok((signers, n))
}

/// Seed bytes collected while resolving one PDA entry. Stack-resident: at most
/// sixteen seeds fit in a 32-byte config (two bytes each), and no resolved
/// seed exceeds 32 bytes, so 512 bytes always suffice.
struct SeedBytes {
    buf: [u8; 512],
    starts: [u16; 16],
    lens: [u8; 16],
    len: usize,
}

fn push_seed(collected: &mut SeedBytes, bytes: &[u8]) -> Result<(), ProgramError> {
    if collected.len >= collected.starts.len() {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut start = 0usize;
    for i in 0..collected.len {
        start += collected.lens[i] as usize;
    }
    let end = start
        .checked_add(bytes.len())
        .ok_or(ProgramError::InvalidAccountData)?;
    if end > collected.buf.len() || bytes.len() > 32 {
        return Err(ProgramError::InvalidAccountData);
    }
    collected.buf[start..end].copy_from_slice(bytes);
    collected.starts[collected.len] = start as u16;
    collected.lens[collected.len] = bytes.len() as u8;
    collected.len += 1;
    Ok(())
}

/// One account in the resolution context: the execute accounts first, then
/// each resolved extra in order — exactly as SPL grows it, so an
/// `AccountKey` seed can reference a previously resolved extra.
#[derive(Clone, Copy)]
struct ContextAccount<'a> {
    key: &'a [u8; 32],
    data: Option<&'a [u8]>,
}

/// Walk a 32-byte `address_config`, resolving every seed against the execute
/// context, and derive the PDA. Mirrors SPL's `Seed::unpack_address_config`
/// plus `resolve_pda`, including the zero-byte terminator.
fn resolve_pda_entry<C>(
    config: &[u8; 32],
    execute_data: &[u8],
    context: &[ContextAccount],
    program_id: &[u8; 32],
    create_pda: &C,
) -> Result<[u8; 32], ProgramError>
where
    C: Fn(&[&[u8]], &[u8; 32]) -> Option<[u8; 32]>,
{
    let mut collected = SeedBytes {
        buf: [0u8; 512],
        starts: [0u16; 16],
        lens: [0u8; 16],
        len: 0,
    };
    let mut at = 0usize;
    while at < 32 {
        let tag = config[at];
        if tag == 0 {
            break;
        }
        match tag {
            1 => {
                // Literal: [1, length, ...bytes].
                if at + 2 > 32 {
                    return Err(resolution_error(
                        resolution_code::INVALID_BYTES_FOR_SEED,
                    ));
                }
                let len = config[at + 1] as usize;
                if at + 2 + len > 32 {
                    return Err(resolution_error(
                        resolution_code::INVALID_BYTES_FOR_SEED,
                    ));
                }
                push_seed(&mut collected, &config[at + 2..at + 2 + len])?;
                at += 2 + len;
            }
            2 => {
                // InstructionData: [2, index, length].
                if at + 3 > 32 {
                    return Err(resolution_error(
                        resolution_code::INVALID_BYTES_FOR_SEED,
                    ));
                }
                let (index, length) = (config[at + 1] as usize, config[at + 2] as usize);
                let end = index.checked_add(length).ok_or(resolution_error(
                    resolution_code::INSTRUCTION_DATA_TOO_SMALL,
                ))?;
                if end > execute_data.len() {
                    return Err(resolution_error(
                        resolution_code::INSTRUCTION_DATA_TOO_SMALL,
                    ));
                }
                push_seed(&mut collected, &execute_data[index..end])?;
                at += 3;
            }
            3 => {
                // AccountKey: [3, index].
                if at + 2 > 32 {
                    return Err(resolution_error(
                        resolution_code::INVALID_BYTES_FOR_SEED,
                    ));
                }
                let index = config[at + 1] as usize;
                let account = context.get(index).ok_or(resolution_error(
                    resolution_code::ACCOUNT_NOT_FOUND,
                ))?;
                push_seed(&mut collected, account.key)?;
                at += 2;
            }
            4 => {
                // AccountData: [4, account_index, data_index, length].
                if at + 4 > 32 {
                    return Err(resolution_error(
                        resolution_code::INVALID_BYTES_FOR_SEED,
                    ));
                }
                let (ai, di, length) = (
                    config[at + 1] as usize,
                    config[at + 2] as usize,
                    config[at + 3] as usize,
                );
                let account = context.get(ai).ok_or(resolution_error(
                    resolution_code::ACCOUNT_NOT_FOUND,
                ))?;
                let data = account.data.ok_or(resolution_error(
                    resolution_code::ACCOUNT_DATA_NOT_FOUND,
                ))?;
                let end = di.checked_add(length).ok_or(resolution_error(
                    resolution_code::ACCOUNT_DATA_TOO_SMALL,
                ))?;
                if data.len() < end {
                    return Err(resolution_error(
                        resolution_code::ACCOUNT_DATA_TOO_SMALL,
                    ));
                }
                push_seed(&mut collected, &data[di..end])?;
                at += 4;
            }
            _ => return Err(ProgramError::InvalidAccountData),
        }
    }
    let mut seeds: [&[u8]; 16] = [&[]; 16];
    for (i, seed) in seeds.iter_mut().enumerate().take(collected.len) {
        let part = collected.starts[i] as usize;
        *seed = &collected.buf[part..part + collected.lens[i] as usize];
    }
    // SPL resolves with `find_program_address`: the bump search from 255
    // down. Calling `create` once with no bump would accept whatever
    // off-curve address the bare seeds happen to yield.
    if collected.len > 15 {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut bump = 255u8;
    loop {
        let bump_seed = [bump];
        let mut full: [&[u8]; 17] = [&[]; 17];
        full[..collected.len].copy_from_slice(&seeds[..collected.len]);
        full[collected.len] = &bump_seed;
        if let Some(key) = create_pda(&full[..collected.len + 1], program_id) {
            return Ok(key);
        }
        if bump == 0 {
            break;
        }
        bump -= 1;
    }
    Err(ProgramError::InvalidSeeds)
}

/// Resolve a `PubkeyData` config: tag 1 reads 32 bytes out of the execute
/// data, tag 2 out of an account's data.
fn resolve_key_data(
    config: &[u8; 32],
    execute_data: &[u8],
    context: &[ContextAccount],
) -> Result<[u8; 32], ProgramError> {
    match config[0] {
        1 => {
            let start = config[1] as usize;
            let end = start
                .checked_add(32)
                .ok_or(ProgramError::InvalidAccountData)?;
            if end > execute_data.len() {
                return Err(resolution_error(
                    resolution_code::INSTRUCTION_DATA_TOO_SMALL,
                ));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&execute_data[start..end]);
            Ok(key)
        }
        2 => {
            let (ai, di) = (config[1] as usize, config[2] as usize);
            let account = context.get(ai).ok_or(resolution_error(
                resolution_code::ACCOUNT_NOT_FOUND,
            ))?;
            let data = account.data.ok_or(resolution_error(
                resolution_code::ACCOUNT_DATA_NOT_FOUND,
            ))?;
            let end = di
                .checked_add(32)
                .ok_or(ProgramError::InvalidAccountData)?;
            if data.len() < end {
                return Err(resolution_error(
                    resolution_code::ACCOUNT_DATA_TOO_SMALL,
                ));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&data[di..end]);
            Ok(key)
        }
        _ => Err(ProgramError::InvalidAccountData),
    }
}

/// One raw 35-byte TLV entry.
struct RawMeta {
    discriminator: u8,
    config: [u8; 32],
    is_signer: bool,
    is_writable: bool,
}

fn read_entry(list_data: &[u8], index: usize) -> Result<RawMeta, ProgramError> {
    let start = 16usize
        .checked_add(
            index
                .checked_mul(35)
                .ok_or(ProgramError::InvalidAccountData)?,
        )
        .ok_or(ProgramError::InvalidAccountData)?;
    let end = start
        .checked_add(35)
        .ok_or(ProgramError::InvalidAccountData)?;
    if list_data.len() < end {
        return Err(ProgramError::InvalidAccountData);
    }
    let entry = &list_data[start..end];
    let mut config = [0u8; 32];
    config.copy_from_slice(&entry[1..33]);
    Ok(RawMeta {
        discriminator: entry[0],
        config,
        is_signer: entry[33] != 0,
        is_writable: entry[34] != 0,
    })
}

fn read_list_count(list_data: &[u8]) -> Result<usize, ProgramError> {
    if list_data.len() < 16 {
        return Err(ProgramError::InvalidAccountData);
    }
    if list_data[..8] != EXECUTE_DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u32::from_le_bytes([list_data[12], list_data[13], list_data[14], list_data[15]]) as usize)
}

/// Resolve one `ExtraAccountMeta` entry against the execute context.
///
/// Discriminator 0 is a fixed pubkey, 1 a PDA of the hook program, 128+N a PDA
/// of context account N, and 2 a pubkey read out of instruction or account
/// data. Anything else fails, as SPL does.
fn resolve_entry<C>(
    entry: &RawMeta,
    execute_data: &[u8],
    context: &[ContextAccount],
    hook_program: &[u8; 32],
    create_pda: &C,
) -> Result<([u8; 32], bool, bool), ProgramError>
where
    C: Fn(&[&[u8]], &[u8; 32]) -> Option<[u8; 32]>,
{
    let (key, signer, writable) = match entry.discriminator {
        0 => (entry.config, entry.is_signer, entry.is_writable),
        1 => (
            resolve_pda_entry(&entry.config, execute_data, context, hook_program, create_pda)?,
            entry.is_signer,
            entry.is_writable,
        ),
        2 => (
            resolve_key_data(&entry.config, execute_data, context)?,
            entry.is_signer,
            entry.is_writable,
        ),
        d if d >= 128 => {
            let index = d.saturating_sub(128) as usize;
            let program = context.get(index).ok_or(resolution_error(
                resolution_code::ACCOUNT_NOT_FOUND,
            ))?;
            (
                resolve_pda_entry(
                    &entry.config,
                    execute_data,
                    context,
                    program.key,
                    create_pda,
                )?,
                entry.is_signer,
                entry.is_writable,
            )
        }
        _ => return Err(ProgramError::InvalidAccountData),
    };
    Ok((key, signer, writable))
}

/// Push one account into the resolution context, silently stopping at the
/// cap. The cap only binds pathological hook lists; see [`MAX_CPI_ACCOUNTS`].
fn push_context<'a>(
    context: &mut [ContextAccount<'a>],
    len: &mut usize,
    key: &'a [u8; 32],
    data: Option<&'a [u8]>,
) {
    if *len < context.len() {
        context[*len] = ContextAccount { key, data };
        *len += 1;
    }
}

/// Build the `transfer_checked` plan: payload plus the exact CPI account list.
///
/// `create_pda` derives PDAs for seed entries; it is a parameter rather than a
/// syscall so this whole function runs on the host in the differential suite.
///
/// Never inlined: the planner's resolution state plus the caller's borrow and
/// CPI arrays exceed one 4 KiB frame together, and each fits comfortably
/// apart.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn plan_transfer_checked<C>(
    token_program: &[u8; 32],
    source: &[u8; 32],
    source_data: &[u8],
    mint: &[u8; 32],
    mint_data: &[u8],
    destination: &[u8; 32],
    destination_data: &[u8],
    authority: &[u8; 32],
    authority_owner: &[u8; 32],
    authority_data: &[u8],
    additional: &[ProvidedAccount],
    amount: u64,
    decimals: u8,
    create_pda: C,
    out: &mut TransferPlan,
) -> Result<(), ProgramError>
where
    C: Fn(&[&[u8]], &[u8; 32]) -> Option<[u8; 32]>,
{
    out.len = 0;
    out.data[0] = TRANSFER_CHECKED_TAG;
    out.data[1..9].copy_from_slice(&amount.to_le_bytes());
    out.data[9] = decimals;

    let multisig = is_multisig(authority_data, authority_owner, token_program);
    out.push(PlannedMeta {
        key: *source,
        is_signer: false,
        is_writable: true,
    })?;
    out.push(PlannedMeta {
        key: *mint,
        is_signer: false,
        is_writable: false,
    })?;
    out.push(PlannedMeta {
        key: *destination,
        is_signer: false,
        is_writable: true,
    })?;
    out.push(PlannedMeta {
        key: *authority,
        is_signer: !multisig,
        is_writable: false,
    })?;

    if multisig {
        // In `additional` order, mirroring SPL's filter over the same list.
        let (signers, n) = multisig_signers(authority_data)?;
        for account in additional.iter() {
            if signers[..n].iter().any(|key| key == account.key) {
                out.push(PlannedMeta {
                    key: *account.key,
                    is_signer: true,
                    is_writable: false,
                })?;
            }
        }
    }

    let Some(hook_program) = transfer_hook_program_id(mint_data)? else {
        return Ok(());
    };

    additional
        .iter()
        .find(|account| account.key == &hook_program)
        .ok_or(ProgramError::Custom(TRANSFER_HOOK_INCORRECT_ACCOUNT))?;

    // The validation-state PDA: `["extra-account-metas", mint]` under the hook
    // program, with the standard 255-to-0 bump search.
    let validation_key = {
        let mut found = None;
        let mut bump = 255u8;
        loop {
            let bump_seed = [bump];
            let seeds: [&[u8]; 3] = [b"extra-account-metas", mint, &bump_seed];
            if let Some(key) = create_pda(&seeds, &hook_program) {
                found = Some(key);
                break;
            }
            if bump == 0 {
                break;
            }
            bump -= 1;
        }
        found.ok_or(ProgramError::InvalidSeeds)?
    };

    let validation = additional
        .iter()
        .find(|account| account.key == &validation_key);
    if let Some(validation) = validation {
        let mut execute_data = [0u8; 16];
        execute_data[..8].copy_from_slice(&EXECUTE_DISC);
        execute_data[8..].copy_from_slice(&amount.to_le_bytes());

        // The resolution context: the execute accounts first, then each
        // resolved extra in order, exactly as SPL grows it.
        let mut context = [ContextAccount {
            key: &[0u8; 32],
            data: None,
        }; MAX_CPI_ACCOUNTS];
        let mut context_len = 0usize;
        push_context(&mut context, &mut context_len, source, Some(source_data));
        push_context(&mut context, &mut context_len, mint, Some(mint_data));
        push_context(
            &mut context,
            &mut context_len,
            destination,
            Some(destination_data),
        );
        push_context(
            &mut context,
            &mut context_len,
            authority,
            Some(authority_data),
        );
        push_context(
            &mut context,
            &mut context_len,
            validation.key,
            Some(validation.data),
        );

        let count = read_list_count(validation.data)?;
        for index in 0..count {
            let entry = read_entry(validation.data, index)?;
            let (key, signer, writable) = resolve_entry(
                &entry,
                &execute_data,
                &context[..context_len],
                &hook_program,
                &create_pda,
            )?;
            let mut meta = PlannedMeta {
                key,
                is_signer: signer,
                is_writable: writable,
            };
            out.de_escalate(&mut meta);
            let resolved = additional
                .iter()
                .find(|account| account.key == &meta.key)
                .ok_or(resolution_error(resolution_code::INCORRECT_ACCOUNT))?;
            out.push(meta)?;
            push_context(
                &mut context,
                &mut context_len,
                resolved.key,
                Some(resolved.data),
            );
        }

        out.push(PlannedMeta {
            key: validation_key,
            is_signer: false,
            is_writable: false,
        })?;
    }

    out.push(PlannedMeta {
        key: hook_program,
        is_signer: false,
        is_writable: false,
    })?;
    Ok(())
}

static ZERO_ADDRESS: Address = Address::new_from_array([0u8; 32]);

/// On-chain wrapper: borrow every account up front, run the plan, map each
/// planned meta back to its view and invoke.
#[allow(clippy::too_many_arguments)]
pub fn invoke_transfer_checked(
    token_program: &AccountView,
    source: &AccountView,
    mint: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    additional: &[&AccountView],
    amount: u64,
    decimals: u8,
    signer_seeds: &[Seed],
) -> Result<(), ProgramError> {
    if additional.len() > MAX_CPI_ACCOUNTS {
        return Err(err(OptionsError::InvalidParams));
    }

    // Borrows end with this block: the plan owns every key it needs, so the
    // invoke below runs with no live borrows and the borrow-state validation
    // cannot trip on a writable meta.
    let plan = {
        let source_data = source.try_borrow()?;
        let source_bytes: &[u8] = &source_data;
        let mint_data = mint.try_borrow()?;
        let mint_bytes: &[u8] = &mint_data;
        let destination_data = destination.try_borrow()?;
        let destination_bytes: &[u8] = &destination_data;
        let authority_data = authority.try_borrow()?;
        let authority_bytes: &[u8] = &authority_data;
        // Borrows are stored first and slices derived from the array places,
        // so nothing moves while borrowed.
        let mut borrowed: [Option<Ref<'_, [u8]>>; MAX_CPI_ACCOUNTS] =
            core::array::from_fn(|_| None);
        let mut provided: [ProvidedAccount; MAX_CPI_ACCOUNTS] = core::array::from_fn(|_| {
            ProvidedAccount {
                key: &[0u8; 32],
                data: &[],
            }
        });
        for (i, account) in additional.iter().enumerate() {
            borrowed[i] = Some(account.try_borrow()?);
        }
        for (i, account) in additional.iter().enumerate() {
            let data: &[u8] = borrowed[i].as_ref().unwrap();
            provided[i] = ProvidedAccount {
                key: account.address().as_array(),
                data,
            };
        }

        let mut plan = TransferPlan {
            data: [0u8; 10],
            metas: [PlannedMeta {
                key: [0u8; 32],
                is_signer: false,
                is_writable: false,
            }; MAX_CPI_ACCOUNTS],
            len: 0,
        };
        plan_transfer_checked(
            token_program.address().as_array(),
            source.address().as_array(),
            source_bytes,
            mint.address().as_array(),
            mint_bytes,
            destination.address().as_array(),
            destination_bytes,
            authority.address().as_array(),
            authority.owner().as_array(),
            authority_bytes,
            &provided[..additional.len()],
            amount,
            decimals,
            |seeds, program| {
                Address::create_program_address(seeds, &Address::new_from_array(*program))
                    .ok()
                    .map(|address| *address.as_array())
            },
            &mut plan,
        )?;
        plan
    };

    let mut metas: [InstructionAccount; MAX_CPI_ACCOUNTS] =
        core::array::from_fn(|_| InstructionAccount::readonly(&ZERO_ADDRESS));
    let mut views: [&AccountView; MAX_CPI_ACCOUNTS] = [&*source; MAX_CPI_ACCOUNTS];
    let base = [source, mint, destination, authority];
    for (i, meta) in plan.metas[..plan.len].iter().enumerate() {
        let view = base
            .iter()
            .chain(additional.iter())
            .find(|view| view.address().as_array() == &meta.key)
            .ok_or(err(OptionsError::InvalidParams))?;
        metas[i] = if meta.is_signer {
            if meta.is_writable {
                InstructionAccount::writable_signer(view.address())
            } else {
                InstructionAccount::readonly_signer(view.address())
            }
        } else if meta.is_writable {
            InstructionAccount::writable(view.address())
        } else {
            InstructionAccount::readonly(view.address())
        };
        views[i] = view;
    }

    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas[..plan.len],
        data: &plan.data,
    };
    if signer_seeds.is_empty() {
        invoke_signed_with_bounds::<MAX_CPI_ACCOUNTS, _>(&ix, &views[..plan.len], &[])
    } else {
        invoke_signed_with_bounds::<MAX_CPI_ACCOUNTS, _>(
            &ix,
            &views[..plan.len],
            &[Signer::from(signer_seeds)],
        )
    }
}
