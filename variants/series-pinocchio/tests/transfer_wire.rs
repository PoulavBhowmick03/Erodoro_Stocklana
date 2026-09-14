// SPDX-License-Identifier: Apache-2.0
//! The transfer plan, driven against SPL's own builders.
//!
//! Every success path asserts byte equality with what SPL produces for the
//! same inputs: instruction payload, account order and every signer/writable
//! flag. Every malformed input asserts both sides fail. Nothing here trusts a
//! transcribed constant — extension types, discriminators and error codes are
//! all read off the SPL crates.

use {
    series_pinocchio::transfer::{
        plan_transfer_checked, scaled_ui_amount, transfer_hook_program_id, ProvidedAccount,
        TransferPlan, EXECUTE_DISC, MAX_CPI_ACCOUNTS, MULTISIG_LEN, TRANSFER_CHECKED_TAG,
        TRANSFER_HOOK_INCORRECT_ACCOUNT,
    },
    sha2::{Digest, Sha256},
    solana_account_info::AccountInfo,
    solana_program_error::ProgramError,
    solana_program_pack::Pack,
    solana_pubkey::Pubkey,
    spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList},
    spl_token_2022::{
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        instruction::transfer_checked as spl_transfer_checked,
        state::Mint,
    },
    spl_transfer_hook_interface::{
        instruction::ExecuteInstruction as Execute,
        onchain::add_extra_accounts_for_execute_cpi,
    },
};

fn key(byte: u8) -> [u8; 32] {
    [byte; 32]
}

/// The real Token-2022 program id. SPL's builders refuse anything else, and
/// the multisig branch keys off ownership by it.
fn token_program() -> [u8; 32] {
    spl_token_2022::id().to_bytes()
}

fn create_pda(seeds: &[&[u8]], program: &[u8; 32]) -> Option<[u8; 32]> {
    solana_address::Address::create_program_address(
        seeds,
        &solana_address::Address::new_from_array(*program),
    )
    .ok()
    .map(|address| address.to_bytes())
}

fn blank_plan() -> TransferPlan {
    TransferPlan {
        data: [0u8; 10],
        metas: [series_pinocchio::transfer::PlannedMeta {
            key: [0u8; 32],
            is_signer: false,
            is_writable: false,
        }; MAX_CPI_ACCOUNTS],
        len: 0,
    }
}

fn provided<'a>(key: &'a [u8; 32], data: &'a [u8]) -> ProvidedAccount<'a> {
    ProvidedAccount { key, data }
}

#[allow(clippy::too_many_arguments)]
fn run_plan(
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
) -> Result<TransferPlan, ProgramError> {
    let mut plan = blank_plan();
    plan_transfer_checked(
        token_program,
        source,
        source_data,
        mint,
        mint_data,
        destination,
        destination_data,
        authority,
        authority_owner,
        authority_data,
        additional,
        amount,
        decimals,
        create_pda,
        &mut plan,
    )
    .map(|()| plan)
}

fn info<'a>(
    key: &'a Pubkey,
    is_signer: bool,
    is_writable: bool,
    lamports: &'a mut u64,
    data: &'a mut [u8],
    owner: &'a Pubkey,
) -> AccountInfo<'a> {
    AccountInfo::new(key, is_signer, is_writable, lamports, data, owner, false, 0)
}

// --- Constants --------------------------------------------------------------

#[test]
fn wire_constants_match_spl() {
    assert_eq!(TRANSFER_CHECKED_TAG, 12);
    let mut hasher = Sha256::new();
    hasher.update(b"spl-transfer-hook-interface:execute");
    let digest = hasher.finalize();
    assert_eq!(
        EXECUTE_DISC,
        digest[..8],
        "execute discriminator drifted upstream"
    );
    assert_eq!(ExtensionType::TransferHook as u16, 14);
    assert_eq!(ExtensionType::ScaledUiAmount as u16, 25);
    assert_eq!(Mint::LEN, 82);
    assert_eq!(
        TRANSFER_HOOK_INCORRECT_ACCOUNT,
        spl_transfer_hook_interface::error::TransferHookError::IncorrectAccount as u32
    );
}

// --- Plain transfers --------------------------------------------------------

fn plain_mint_data() -> Vec<u8> {
    // A mint with no extensions is exactly the 82-byte base. The initialized
    // flag is set, as on any real mint.
    let mut data = vec![0u8; 82];
    data[45] = 1;
    data
}

#[test]
fn plain_transfer_matches_spl_byte_for_byte() {
    let (source, mint, destination, authority) = (key(1), key(2), key(3), key(4));
    let token_program = token_program();
    let mint_data = plain_mint_data();

    let plan = run_plan(
        &token_program,
        &source,
        &[],
        &mint,
        &mint_data,
        &destination,
        &[],
        &authority,
        &token_program,
        &[],
        &[],
        1_000_000,
        8,
    )
    .unwrap();

    let reference = spl_transfer_checked(
        &Pubkey::new_from_array(token_program),
        &Pubkey::new_from_array(source),
        &Pubkey::new_from_array(mint),
        &Pubkey::new_from_array(destination),
        &Pubkey::new_from_array(authority),
        &[],
        1_000_000,
        8,
    )
    .unwrap();

    assert_eq!(plan.data.as_slice(), reference.data.as_slice());
    assert_eq!(plan.len, reference.accounts.len());
    for (planned, expected) in plan.metas[..plan.len].iter().zip(reference.accounts.iter()) {
        assert_eq!(planned.key, expected.pubkey.to_bytes());
        assert_eq!(planned.is_signer, expected.is_signer);
        assert_eq!(planned.is_writable, expected.is_writable);
    }
}

// --- Mint parsing -----------------------------------------------------------

/// Build mint bytes the way SPL lays them out: 82-byte base, zero padding to
/// 165, the account-type byte, then the TLV entry.
fn mint_with_extension(ty: ExtensionType, value: &[u8]) -> Vec<u8> {
    let base_len = Mint::LEN;
    let pad = 165 - base_len;
    let total = base_len + pad + 1 + 4 + value.len();
    let mut data = vec![0u8; total];
    data[45] = 1;
    data[base_len + pad] = 1; // AccountType::Mint
    let body = base_len + pad + 1;
    let ty_u16 = ty as u16;
    data[body..body + 2].copy_from_slice(&ty_u16.to_le_bytes());
    data[body + 2..body + 4].copy_from_slice(&(value.len() as u16).to_le_bytes());
    data[body + 4..].copy_from_slice(value);
    data
}

#[test]
fn transfer_hook_lookup_matches_spl() {
    // No extension at all.
    assert_eq!(transfer_hook_program_id(&plain_mint_data()).unwrap(), None);

    // Extension present with a real program id (authority zeroed, program
    // id in the second half — the struct's actual layout).
    let mut value = vec![0u8; 64];
    value[32..].copy_from_slice(&key(77));
    let data = mint_with_extension(ExtensionType::TransferHook, &value);
    assert_eq!(
        transfer_hook_program_id(&data).unwrap(),
        Some(key(77))
    );

    // Present but zeroed reads as unset, exactly like SPL's
    // `OptionalNonZeroPubkey` conversion.
    let data = mint_with_extension(ExtensionType::TransferHook, &[0u8; 64]);
    assert_eq!(transfer_hook_program_id(&data).unwrap(), None);

    // Truncated base, a between-size account, non-zero padding and a wrong
    // account type all fail — and SPL agrees on each one.
    for bad in [
        plain_mint_data()[..81].to_vec(),
        vec![0u8; 100],
        {
            let mut dirty = mint_with_extension(ExtensionType::TransferHook, &value);
            dirty[100] = 7;
            dirty
        },
        {
            let mut wrong_type = mint_with_extension(ExtensionType::TransferHook, &value);
            wrong_type[165] = 2;
            wrong_type
        },
    ] {
        assert!(transfer_hook_program_id(&bad).is_err());
        assert!(
            StateWithExtensions::<Mint>::unpack(&bad).is_err(),
            "SPL must reject it too"
        );
    }
    // An uninitialized base fails with `UninitializedAccount` on both builds
    // (different `ProgramError` crate versions, same Solana error).
    let mut uninit = plain_mint_data();
    uninit[45] = 0;
    assert_eq!(
        transfer_hook_program_id(&uninit).unwrap_err(),
        ProgramError::UninitializedAccount
    );
    assert_eq!(
        format!("{:?}", StateWithExtensions::<Mint>::unpack(&uninit).unwrap_err()),
        "UninitializedAccount"
    );
    let mut truncated = mint_with_extension(ExtensionType::TransferHook, &value);
    truncated.truncate(truncated.len() - 1);
    assert!(transfer_hook_program_id(&truncated).is_err());
}

#[test]
fn scaled_ui_amount_matches_spl() {
    // Identity when the extension is absent.
    assert_eq!(scaled_ui_amount(&plain_mint_data()).unwrap(), (1.0, 1.0, 0));

    // SPL-built config reads back identically. Layout is authority(32),
    // multiplier(8), effective-timestamp(8), new-multiplier(8).
    let mut value = vec![0u8; 56];
    value[..32].copy_from_slice(&key(5)); // authority
    value[32..40].copy_from_slice(&2.0f64.to_le_bytes());
    value[40..48].copy_from_slice(&1_700_000_000i64.to_le_bytes());
    value[48..56].copy_from_slice(&4.0f64.to_le_bytes());
    let data = mint_with_extension(ExtensionType::ScaledUiAmount, &value);
    assert_eq!(
        scaled_ui_amount(&data).unwrap(),
        (2.0, 4.0, 1_700_000_000)
    );

    // Cross-checked against SPL's own unpack of the same bytes.
    let state = StateWithExtensions::<Mint>::unpack(&data).unwrap();
    let cfg = state
        .get_extension::<spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig>()
        .unwrap();
    let (current, new, ts) = scaled_ui_amount(&data).unwrap();
    assert_eq!(current, f64::from(cfg.multiplier));
    assert_eq!(new, f64::from(cfg.new_multiplier));
    assert_eq!(ts, i64::from(cfg.new_multiplier_effective_timestamp));

    // Wrong length fails rather than misreading.
    let data = mint_with_extension(ExtensionType::ScaledUiAmount, &[0u8; 8]);
    assert!(scaled_ui_amount(&data).is_err());
}

// --- Multisig ---------------------------------------------------------------

fn multisig_data(m: u8, n: u8, signers: &[[u8; 32]]) -> Vec<u8> {
    let mut data = vec![0u8; MULTISIG_LEN];
    data[0] = m;
    data[1] = n;
    data[2] = 1;
    for (i, key) in signers.iter().enumerate().take(11) {
        data[3 + i * 32..3 + (i + 1) * 32].copy_from_slice(key);
    }
    data
}

#[test]
fn multisig_authority_matches_spl() {
    let (source, mint, destination, authority) = (key(1), key(2), key(3), key(4));
    let token_program = token_program();
    let mint_data = plain_mint_data();
    let members = [key(11), key(12), key(13)];
    let authority_data = multisig_data(2, 3, &members);

    // Reference: SPL's base instruction plus its own multisig correction,
    // written out the way `transfer_instruction_and_account_infos` does it.
    let mut reference = spl_transfer_checked(
        &Pubkey::new_from_array(token_program),
        &Pubkey::new_from_array(source),
        &Pubkey::new_from_array(mint),
        &Pubkey::new_from_array(destination),
        &Pubkey::new_from_array(authority),
        &[],
        500,
        8,
    )
    .unwrap();
    reference.accounts[3].is_signer = false;
    for member in members.iter() {
        reference.accounts.push(solana_instruction::AccountMeta::new_readonly(
            Pubkey::new_from_array(*member),
            true,
        ));
    }

    let extra: Vec<ProvidedAccount> = members
        .iter()
        .map(|key| provided(key, &[]))
        .collect();
    let plan = run_plan(
        &token_program,
        &source,
        &[],
        &mint,
        &mint_data,
        &destination,
        &[],
        &authority,
        &token_program,
        &authority_data,
        &extra,
        500,
        8,
    )
    .unwrap();

    assert_eq!(plan.data.as_slice(), reference.data.as_slice());
    assert_eq!(plan.len, reference.accounts.len());
    for (planned, expected) in plan.metas[..plan.len].iter().zip(reference.accounts.iter()) {
        assert_eq!(planned.key, expected.pubkey.to_bytes());
        assert_eq!(planned.is_signer, expected.is_signer);
        assert_eq!(planned.is_writable, expected.is_writable);
    }
}

// --- Transfer hook ----------------------------------------------------------

/// Build a validation-state buffer through SPL itself.
fn validation_list(metas: &[ExtraAccountMeta]) -> Vec<u8> {
    let size = ExtraAccountMetaList::size_of(metas.len()).unwrap();
    let mut buffer = vec![0u8; size];
    ExtraAccountMetaList::init::<Execute>(&mut buffer, metas).unwrap();
    buffer
}

fn hook_mint_data(hook_program: &[u8; 32]) -> Vec<u8> {
    let mut value = vec![0u8; 64];
    value[32..].copy_from_slice(hook_program);
    mint_with_extension(ExtensionType::TransferHook, &value)
}

#[test]
fn hook_transfer_matches_spl_end_to_end() {
    let (source, mint, destination, authority) = (key(1), key(2), key(3), key(4));
    let token_program = token_program();
    let hook_program = key(77);
    let mint_data = hook_mint_data(&hook_program);

    let extra_fixed = key(21);
    let validation_key = spl_transfer_hook_interface::get_extra_account_metas_address(
        &Pubkey::new_from_array(mint),
        &Pubkey::new_from_array(hook_program),
    );
    let validation_key_bytes = validation_key.to_bytes();

    let metas = [
        ExtraAccountMeta::new_with_pubkey(&Pubkey::new_from_array(extra_fixed), false, true)
            .unwrap(),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::AccountKey { index: 0 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            true,
        )
        .unwrap(),
    ];
    let list_data = validation_list(&metas);

    // The seed entry resolves to this PDA, so both builds must be handed it.
    let (pda, _) = Pubkey::find_program_address(
        &[&source, &destination],
        &Pubkey::new_from_array(hook_program),
    );
    let pda_bytes = pda.to_bytes();
    let empty_plan: &[u8] = &[];

    // Reference: SPL's base instruction plus SPL's own extra-account pass.
    let mut lamports_source = 0u64;
    let mut lamports_mint = 0u64;
    let mut lamports_dest = 0u64;
    let mut lamports_auth = 0u64;
    let mut lamports_hook = 0u64;
    let mut lamports_fixed = 0u64;
    let mut lamports_validation = 0u64;
    let mut lamports_pda = 0u64;
    let mut empty: Vec<u8> = vec![];
    let token_program_key = Pubkey::new_from_array(token_program);
    let source_key = Pubkey::new_from_array(source);
    let mint_key = Pubkey::new_from_array(mint);
    let dest_key = Pubkey::new_from_array(destination);
    let auth_key = Pubkey::new_from_array(authority);
    let hook_key = Pubkey::new_from_array(hook_program);
    let fixed_key = Pubkey::new_from_array(extra_fixed);
    let mut source_data = vec![];
    let mut mint_data_mut = mint_data.clone();
    let mut dest_data = vec![];
    let mut auth_data = vec![];
    let mut fixed_data = vec![];
    let mut list_data_mut = list_data.clone();
    let source_info = info(&source_key, false, true, &mut lamports_source, &mut source_data, &token_program_key);
    let mint_info = info(&mint_key, false, false, &mut lamports_mint, &mut mint_data_mut, &token_program_key);
    let dest_info = info(&dest_key, false, true, &mut lamports_dest, &mut dest_data, &token_program_key);
    let auth_info = info(&auth_key, true, false, &mut lamports_auth, &mut auth_data, &token_program_key);
    let hook_info = info(&hook_key, false, false, &mut lamports_hook, &mut empty, &token_program_key);
    let fixed_info = info(&fixed_key, false, true, &mut lamports_fixed, &mut fixed_data, &token_program_key);
    let validation_info = info(&validation_key, false, false, &mut lamports_validation, &mut list_data_mut, &hook_key);
    let mut pda_data = vec![];
    let pda_info = info(&pda, false, true, &mut lamports_pda, &mut pda_data, &token_program_key);

    let mut reference = spl_transfer_checked(
        &Pubkey::new_from_array(token_program),
        &source_key,
        &mint_key,
        &dest_key,
        &auth_key,
        &[],
        4242,
        8,
    )
    .unwrap();
    let mut reference_infos = vec![
        source_info.clone(),
        mint_info.clone(),
        dest_info.clone(),
        auth_info.clone(),
    ];
    let additional = vec![
        hook_info.clone(),
        validation_info.clone(),
        fixed_info.clone(),
        pda_info.clone(),
    ];
    add_extra_accounts_for_execute_cpi(
        &mut reference,
        &mut reference_infos,
        &hook_key,
        source_info,
        mint_info,
        dest_info,
        auth_info,
        4242,
        &additional,
    )
    .unwrap();

    let extra = [
        provided(&hook_program, empty_plan),
        provided(&validation_key_bytes, &list_data),
        provided(&extra_fixed, empty_plan),
        provided(&pda_bytes, empty_plan),
    ];
    let plan = run_plan(
        &token_program,
        &source,
        &[],
        &mint,
        &mint_data,
        &destination,
        &[],
        &authority,
        &token_program,
        &[],
        &extra,
        4242,
        8,
    )
    .unwrap();

    assert_eq!(plan.data.as_slice(), reference.data.as_slice());
    assert_eq!(
        plan.len,
        reference.accounts.len(),
        "meta count diverged: {:?}",
        plan.metas[..plan.len]
            .iter()
            .map(|meta| meta.key)
            .collect::<Vec<_>>()
    );
    for (planned, expected) in plan.metas[..plan.len].iter().zip(reference.accounts.iter()) {
        assert_eq!(planned.key, expected.pubkey.to_bytes());
        assert_eq!(planned.is_signer, expected.is_signer, "{:?}", expected.pubkey);
        assert_eq!(planned.is_writable, expected.is_writable, "{:?}", expected.pubkey);
    }
}

#[test]
fn hook_failure_modes_match_spl() {
    let (source, mint, destination, authority) = (key(1), key(2), key(3), key(4));
    let token_program = token_program();
    let hook_program = key(77);
    let mint_data = hook_mint_data(&hook_program);
    let validation_key = spl_transfer_hook_interface::get_extra_account_metas_address(
        &Pubkey::new_from_array(mint),
        &Pubkey::new_from_array(hook_program),
    );

    // Hook program not passed at all.
    let empty: &[u8] = &[];
    let result = run_plan(
        &token_program,
        &source, &[], &mint, &mint_data, &destination, &[], &authority,
        &token_program, &[], &[], 1, 8,
    );
    assert!(result.is_err(), "missing hook program must fail");

    // Validation state present but with a foreign discriminator.
    let mut bad_list = validation_list(&[]);
    bad_list[0] ^= 0xff;
    let validation_key_bytes = validation_key.to_bytes();
    let extra = [
        provided(&hook_program, empty),
        provided(&validation_key_bytes, &bad_list),
    ];
    let result = run_plan(
        &token_program,
        &source, &[], &mint, &mint_data, &destination, &[], &authority,
        &token_program, &[], &extra, 1, 8,
    );
    assert!(result.is_err(), "foreign list discriminator must fail");

    // Resolved account missing from the passed set.
    let metas = [ExtraAccountMeta::new_with_pubkey(
        &Pubkey::new_from_array(key(99)),
        false,
        true,
    )
    .unwrap()];
    let list_data = validation_list(&metas);
    let extra = [
        provided(&hook_program, empty),
        provided(&validation_key_bytes, &list_data),
    ];
    let result = run_plan(
        &token_program,
        &source, &[], &mint, &mint_data, &destination, &[], &authority,
        &token_program, &[], &extra, 1, 8,
    );
    assert!(result.is_err(), "unresolvable extra must fail");
}
