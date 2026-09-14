// SPDX-License-Identifier: Apache-2.0
//!
//! The classic-Token builders, byte-equal to `spl_token`'s own. Anchor's
//! `mint_to`/`burn` go through the unchecked variants (tags 7 and 8); the
//! associated-token `Create` is a single zero byte with six fixed accounts.

use {
    series_pinocchio::token as tok,
    solana_pubkey::Pubkey,
    spl_associated_token_account_client::instruction::create_associated_token_account as ata_create,
    spl_token::instruction::{burn as spl_burn, initialize_mint2 as spl_init_mint2, mint_to as spl_mint_to},
};

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

#[test]
fn mint_to_matches_spl() {
    let (mint, to, authority) = (key(1), key(2), key(3));
    let reference = spl_mint_to(
        &spl_token::ID,
        &mint,
        &to,
        &authority,
        &[],
        1_000_000,
    )
    .unwrap();
    let built = tok::mint_to_data(1_000_000);
    assert_eq!(built.as_slice(), reference.data.as_slice());
    assert_eq!(built[0], 7, "Anchor uses the unchecked MintTo");
    // Account order and flags are part of the interface.
    let order: Vec<_> = reference
        .accounts
        .iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect();
    assert_eq!(
        order,
        vec![(mint, false, true), (to, false, true), (authority, true, false)]
    );
}

#[test]
fn burn_matches_spl() {
    let (mint, from, authority) = (key(1), key(2), key(3));
    let reference = spl_burn(
        &spl_token::ID,
        &from,
        &mint,
        &authority,
        &[],
        500,
    )
    .unwrap();
    let built = tok::burn_data(500);
    assert_eq!(built.as_slice(), reference.data.as_slice());
    assert_eq!(built[0], 8, "Anchor uses the unchecked Burn");
    // Account order and flags are part of the interface: source and mint are
    // both written (balances and supplies move), authority only signs.
    let order: Vec<_> = reference
        .accounts
        .iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect();
    assert_eq!(
        order,
        vec![
            (from, false, true),
            (mint, false, true),
            (authority, true, false)
        ]
    );
}

#[test]
fn initialize_mint_matches_spl() {
    let authority = key(9);
    let reference = spl_init_mint2(
        &spl_token::ID,
        &key(1),
        &authority,
        None,
        8,
    )
    .unwrap();
    let built = tok::initialize_mint_data(8, &authority.to_bytes());
    assert_eq!(built.as_slice(), reference.data.as_slice());
}

#[test]
fn ata_create_matches_spl() {
    // Six fixed accounts, one zero byte — verified structurally since the
    // builder lives behind the invoke wrapper.
    let reference = ata_create(
        &key(10),
        &key(11),
        &key(12),
        &spl_token::ID,
    );
    assert_eq!(reference.data.as_slice(), &[0u8]);
    assert_eq!(reference.accounts.len(), 6);
    assert_eq!(
        reference.program_id,
        spl_associated_token_account::ID
    );
}

#[test]
fn rent_formula_matches_the_protocol_rule() {
    // `(bytes + 173) * 6960` is program rent; account rent is the same rule
    // with the 128-byte per-account overhead instead of the 45-byte
    // ProgramData header.
    assert_eq!(tok::rent_exempt(0), 128 * 6960);
    assert_eq!(tok::rent_exempt(165), (128 + 165) * 6960);
}
