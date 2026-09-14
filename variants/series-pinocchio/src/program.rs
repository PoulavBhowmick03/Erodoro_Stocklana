// SPDX-License-Identifier: Apache-2.0
//! The instruction layer: dispatch, the checks Anchor would have generated, and
//! the ten handlers.
//!
//! # What Anchor was doing here
//!
//! Every `#[account(...)]` attribute in `programs/series/src/lib.rs` is a check
//! that no longer exists unless it is written below. The load-bearing ones:
//!
//! - `has_one` on every instruction binding the vault, mints and oracle back
//!   to the series config — without one, a series could be presented alongside
//!   another series' vault.
//! - `seeds` with the *stored* bump, re-derived with `create_program_address`
//!   rather than searched: searching would accept an account at *some* valid
//!   bump, Anchor accepts only the recorded one. `init` paths search instead,
//!   exactly as Anchor's `init` does.
//! - `token::mint`, `token::authority` and `mint::token_program` on every
//!   token account, so a caller cannot fund a split out of somebody else's
//!   account or present a vault for the wrong mint.
//! - The `Option` fee vault in `split`, which Anchor resolves by program-id
//!   sentinel: the next account is the vault unless its key *is* the program
//!   id, in which case it is consumed as the placeholder for `None`.
//!
//! # Error policy
//!
//! Custom errors surface the same 6000-based codes as the Anchor build,
//! through [`crate::error::err`] — including through `require!`,
//! `require_keys_eq!` and `require_keys_neq!`, which return the domain error
//! they are given rather than any framework code. Malformed instructions
//! surface 102, short account lists 3005, and wrong program ids 3008, each
//! asserted against `anchor_lang::error::ErrorCode` in
//! `tests/framework_wire.rs`. Structural account checks (owner, signer,
//! writable, PDA) follow the sibling ports and return Pinocchio-native codes;
//! they fail closed either way, and no suite pins their numbers.

use {
    crate::{
        accounts, collateral, error::{err, OrProgramError}, events, logic, oracle,
        state::{SeriesConfig, Settlement, SeriesStatus, SERIES_CONFIG_LEN, SETTLEMENT_LEN},
        token,
    },
    common::OptionsError,
    pinocchio::{
        account::AccountView,
        address::Address,
        cpi::Seed,
        error::ProgramError,
        sysvars::{clock::Clock, Sysvar},
        ProgramResult,
    },
};

/// Anchor instruction discriminators: `sha256("global:<snake_case_name>")[..8]`.
/// Derived in the tests rather than trusted as literals.
pub mod ix {
    pub const CREATE_SERIES: [u8; 8] = [181, 9, 52, 120, 197, 221, 42, 142];
    pub const SPLIT: [u8; 8] = [124, 189, 27, 43, 216, 40, 147, 66];
    pub const MERGE: [u8; 8] = [148, 141, 236, 47, 174, 126, 69, 111];
    pub const SETTLE: [u8; 8] = [175, 42, 185, 87, 144, 131, 102, 212];
    pub const REDEEM_P: [u8; 8] = [38, 10, 35, 199, 210, 174, 56, 224];
    pub const REDEEM_N: [u8; 8] = [48, 213, 124, 207, 253, 219, 141, 168];
    pub const PAUSE_SPLITS: [u8; 8] = [3, 215, 219, 55, 27, 61, 246, 126];
    pub const UNPAUSE_SPLITS: [u8; 8] = [46, 12, 255, 148, 149, 190, 101, 155];
    pub const RENOUNCE_ADMIN: [u8; 8] = [223, 213, 55, 194, 0, 108, 225, 137];
    pub const SWEEP_DUST: [u8; 8] = [9, 49, 242, 88, 156, 84, 109, 15];
}

/// Anchor framework codes replicated on paths the test suite pins. Each is
/// asserted against `anchor_lang::error::ErrorCode` in
/// `tests/framework_wire.rs`.
///
/// Note what is *not* here: Anchor's `require!`, `require_keys_eq!` and
/// `require_keys_neq!` return the *custom* error they are given, not the
/// 2500-range codes — those only surface when no error is passed, which never
/// happens in this program. The helpers below take the domain error for
/// exactly that reason.
pub mod framework_code {
    /// Short discriminator or argument body.
    pub const INSTRUCTION_DID_NOT_DESERIALIZE: u32 = 102;
    /// Fewer accounts than the fixed list names.
    pub const NOT_ENOUGH_KEYS: u32 = 3005;
    /// A program account with an unexpected id.
    pub const INVALID_PROGRAM_ID: u32 = 3008;
    /// A classic mint account that is system-owned and empty.
    pub const NOT_INITIALIZED: u32 = 3012;
    /// A classic mint account owned by another program.
    pub const OWNED_BY_WRONG_PROGRAM: u32 = 3007;
}

fn framework_error(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

/// Anchor's `require!(condition, OptionsError::X)`: the custom error, not a
/// framework code.
fn require(condition: bool, error: OptionsError) -> Result<(), ProgramError> {
    if !condition {
        return Err(err(error));
    }
    Ok(())
}

/// Anchor's `require_keys_eq!` with a domain error.
fn require_keys_eq(
    actual: &[u8; 32],
    expected: &[u8; 32],
    error: OptionsError,
) -> Result<(), ProgramError> {
    if actual != expected {
        return Err(err(error));
    }
    Ok(())
}

/// Anchor's `require_keys_neq!` with a domain error.
fn require_keys_neq(
    first: &[u8; 32],
    second: &[u8; 32],
    error: OptionsError,
) -> Result<(), ProgramError> {
    if first == second {
        return Err(err(error));
    }
    Ok(())
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 8 {
        return Err(framework_error(
            framework_code::INSTRUCTION_DID_NOT_DESERIALIZE,
        ));
    }
    let (disc, args) = data.split_at(8);
    let disc: [u8; 8] = disc.try_into().map_err(|_| ProgramError::InvalidArgument)?;

    match disc {
        ix::CREATE_SERIES => create_series(program_id, accounts, args),
        ix::SPLIT => split(program_id, accounts, args),
        ix::MERGE => merge(program_id, accounts, args),
        ix::SETTLE => settle(program_id, accounts),
        ix::REDEEM_P => redeem(program_id, accounts, args, true),
        ix::REDEEM_N => redeem(program_id, accounts, args, false),
        ix::PAUSE_SPLITS => pause_splits(program_id, accounts, true),
        ix::UNPAUSE_SPLITS => pause_splits(program_id, accounts, false),
        ix::RENOUNCE_ADMIN => renounce_admin(program_id, accounts),
        ix::SWEEP_DUST => sweep_dust(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// --- Small readers ----------------------------------------------------------

fn read_u64(args: &[u8]) -> Result<u64, ProgramError> {
    if args.len() < 8 {
        return Err(framework_error(
            framework_code::INSTRUCTION_DID_NOT_DESERIALIZE,
        ));
    }
    Ok(u64::from_le_bytes(args[..8].try_into().unwrap()))
}

/// Canonical PDA search, 255 down: what Anchor's `init` does.
fn find_pda(seeds: &[&[u8]], program_id: &Address) -> (Address, u8) {
    let mut bump = 255u8;
    loop {
        let bump_seed = [bump];
        let mut full: [&[u8]; 9] = [&[]; 9];
        let mut len = 0;
        for seed in seeds.iter() {
            if len < full.len() {
                full[len] = seed;
                len += 1;
            }
        }
        full[len] = &bump_seed;
        if let Ok(address) = Address::create_program_address(&full[..len + 1], program_id) {
            return (address, bump);
        }
        if bump == 0 {
            break;
        }
        bump -= 1;
    }
    // Unreachable for well-formed seeds: some bump always works. Failing
    // closed rather than inventing an address.
    (Address::new_from_array([0u8; 32]), 255)
}

/// Owned copies of the series PDA's seeds, for CPI signing.
struct SeriesSeeds {
    creator: [u8; 32],
    collateral_mint: [u8; 32],
    strike: [u8; 16],
    maturity_ts: [u8; 8],
    bump: [u8; 1],
}

impl SeriesSeeds {
    fn new(config: &SeriesConfig) -> Self {
        Self {
            creator: config.factory,
            collateral_mint: config.collateral_mint,
            strike: config.strike.to_le_bytes(),
            maturity_ts: config.maturity_ts.to_le_bytes(),
            bump: [config.bump],
        }
    }

    fn as_seeds(&self) -> [Seed<'_>; 6] {
        [
            Seed::from(crate::state::SERIES_SEED),
            Seed::from(&self.creator[..]),
            Seed::from(&self.collateral_mint[..]),
            Seed::from(&self.strike[..]),
            Seed::from(&self.maturity_ts[..]),
            Seed::from(&self.bump[..]),
        ]
    }
}

/// Parameters for a new series: the borsh body Anchor's client sends, in
/// field order. Fixed 62 bytes.
struct CreateSeriesParams {
    strike: i128,
    maturity_ts: i64,
    price_decimals: u32,
    settlement_delay_secs: i64,
    max_oracle_age_secs: i64,
    max_price_lag_secs: i64,
    min_split_amount: u64,
    fee_bps: u16,
}

fn read_create_params(args: &[u8]) -> Result<CreateSeriesParams, ProgramError> {
    if args.len() < 62 {
        return Err(framework_error(
            framework_code::INSTRUCTION_DID_NOT_DESERIALIZE,
        ));
    }
    let mut strike = [0u8; 16];
    let mut maturity_ts = [0u8; 8];
    let mut price_decimals = [0u8; 4];
    let mut settlement_delay_secs = [0u8; 8];
    let mut max_oracle_age_secs = [0u8; 8];
    let mut max_price_lag_secs = [0u8; 8];
    let mut min_split_amount = [0u8; 8];
    let mut fee_bps = [0u8; 2];
    strike.copy_from_slice(&args[..16]);
    maturity_ts.copy_from_slice(&args[16..24]);
    price_decimals.copy_from_slice(&args[24..28]);
    settlement_delay_secs.copy_from_slice(&args[28..36]);
    max_oracle_age_secs.copy_from_slice(&args[36..44]);
    max_price_lag_secs.copy_from_slice(&args[44..52]);
    min_split_amount.copy_from_slice(&args[52..60]);
    fee_bps.copy_from_slice(&args[60..62]);
    Ok(CreateSeriesParams {
        strike: i128::from_le_bytes(strike),
        maturity_ts: i64::from_le_bytes(maturity_ts),
        price_decimals: u32::from_le_bytes(price_decimals),
        settlement_delay_secs: i64::from_le_bytes(settlement_delay_secs),
        max_oracle_age_secs: i64::from_le_bytes(max_oracle_age_secs),
        max_price_lag_secs: i64::from_le_bytes(max_price_lag_secs),
        min_split_amount: u64::from_le_bytes(min_split_amount),
        fee_bps: u16::from_le_bytes(fee_bps),
    })
}

/// The collateral token program must be one of the two token programs, as
/// Anchor's `Interface<TokenInterface>` enforces. Anything else fails closed;
/// no suite pins the number, so this stays a domain error.
fn check_token_interface(program: &AccountView) -> Result<(), ProgramError> {
    let key = program.address().as_array();
    if key != &token::TOKEN_PROGRAM_ID && key != &crate::accounts::SPL_TOKEN_2022_ID {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(())
}

fn check_program(account: &AccountView, expected: &[u8; 32]) -> Result<(), ProgramError> {
    if account.address().as_array() != expected {
        return Err(framework_error(framework_code::INVALID_PROGRAM_ID));
    }
    Ok(())
}

/// A classic SPL mint account: system-owned empties read as not-initialized
/// (3012) and anything owned by another program as wrong-owner (3007), in the
/// order Anchor checks them. Proven against `ErrorCode` in framework_wire.
fn check_token_owner(account: &AccountView) -> Result<(), ProgramError> {
    if account.owner() == &Address::new_from_array(token::SYSTEM_PROGRAM_ID)
        && account.data_len() == 0
    {
        return Err(framework_error(framework_code::NOT_INITIALIZED));
    }
    if account.owner().as_array() != &token::TOKEN_PROGRAM_ID {
        return Err(framework_error(framework_code::OWNED_BY_WRONG_PROGRAM));
    }
    Ok(())
}

/// Trailing accounts as shared views, capped at 24. The `fallback` fills
/// slots past the end and is never read; it exists because Rust has no
/// uninitialized shared references. Every handler validates its fixed prefix
/// first.
fn extra_views<'a>(
    accounts: &'a [AccountView],
    fallback: &'a AccountView,
) -> ([&'a AccountView; 24], usize) {
    let mut out = [fallback; 24];
    let n = accounts.len().min(24);
    for (i, view) in out.iter_mut().enumerate().take(n) {
        *view = &accounts[i];
    }
    (out, n)
}

// --- create_series ----------------------------------------------------------

fn create_series(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> Result<(), ProgramError> {
    let [
        payer,
        factory_authority,
        admin,
        series,
        collateral_mint,
        collateral_vault,
        oracle_adapter,
        p_mint,
        n_mint,
        fee_recipient,
        collateral_token_program,
        token_program,
        associated_token_program,
        system_program,
    ] = accounts
    else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };
    let params = read_create_params(args)?;

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::signer(factory_authority)?;
    check_token_interface(collateral_token_program)?;
    check_program(token_program, &token::TOKEN_PROGRAM_ID)?;
    check_program(
        associated_token_program,
        &token::ASSOCIATED_TOKEN_PROGRAM_ID,
    )?;
    check_program(system_program, &token::SYSTEM_PROGRAM_ID)?;
    // The collateral mint is owned by the named token program.
    accounts::mint_token_program(collateral_mint, collateral_token_program)?;
    accounts::mint(collateral_mint)?;

    let now = Clock::get()?.unix_timestamp;
    let multipliers = collateral::read_multipliers(collateral_mint)?;
    collateral::require_no_scheduled_change(&multipliers, now, params.maturity_ts)?;
    let multiplier_at_creation = multipliers.fixed_at(now)?;

    // The feed this series will settle against.
    accounts::owned_by_program(oracle_adapter, &Address::new_from_array(oracle::ORACLE_ADAPTER_PROGRAM_ID))?;
    let feed_data = oracle_adapter.try_borrow()?;
    let feed = oracle::read_feed_config(
        oracle_adapter.owner().as_array(),
        &feed_data,
    )?;

    logic::validate_series_params(
        params.strike,
        params.price_decimals,
        params.maturity_ts,
        now,
        params.settlement_delay_secs,
        params.max_oracle_age_secs,
        params.max_price_lag_secs,
        params.min_split_amount,
        params.fee_bps,
        multiplier_at_creation,
    )?;
    logic::validate_settlement_timing(
        params.settlement_delay_secs,
        params.max_oracle_age_secs,
        params.max_price_lag_secs,
        feed.max_age_secs,
    )?;
    require(
        feed.min_verification_signatures > 0,
        OptionsError::InvalidOracle,
    )?;
    require_keys_neq(
        p_mint.address().as_array(),
        n_mint.address().as_array(),
        OptionsError::InvalidParams,
    )?;

    // Canonical addresses, searched like Anchor's `init`.
    let strike_bytes = params.strike.to_le_bytes();
    let maturity_bytes = params.maturity_ts.to_le_bytes();
    let (series_key, series_bump) = find_pda(
        &[
            crate::state::SERIES_SEED,
            factory_authority.address().as_array(),
            collateral_mint.address().as_array(),
            &strike_bytes,
            &maturity_bytes,
        ],
        program_id,
    );
    require_keys_eq(
        series.address().as_array(),
        series_key.as_array(),
        OptionsError::InvalidParams,
    )?;
    let (p_mint_key, p_bump) = find_pda(
        &[crate::state::P_MINT_SEED, series.address().as_array()],
        program_id,
    );
    require_keys_eq(
        p_mint.address().as_array(),
        p_mint_key.as_array(),
        OptionsError::InvalidParams,
    )?;
    let (n_mint_key, n_bump) = find_pda(
        &[crate::state::N_MINT_SEED, series.address().as_array()],
        program_id,
    );
    require_keys_eq(
        n_mint.address().as_array(),
        n_mint_key.as_array(),
        OptionsError::InvalidParams,
    )?;

    // Fresh accounts for the three creates: system-owned and empty.
    for target in [&*series, &*p_mint, &*n_mint] {
        if target.owner() != system_program.address() || target.data_len() != 0 {
            return Err(err(OptionsError::InvalidParams));
        }
    }

    let mint_data = collateral_mint.try_borrow()?;
    let collateral_decimals = token::mint_decimals(&mint_data)?;
    drop(mint_data);

    let series_bump_seed = [series_bump];
    token::create_account(payer, series, program_id, SERIES_CONFIG_LEN, &[
        Seed::from(crate::state::SERIES_SEED),
        Seed::from(factory_authority.address().as_array().as_slice()),
        Seed::from(collateral_mint.address().as_array().as_slice()),
        Seed::from(&strike_bytes[..]),
        Seed::from(&maturity_bytes[..]),
        Seed::from(&series_bump_seed[..]),
    ])?;
    token::create_associated_token_account(
        associated_token_program,
        payer,
        collateral_vault,
        series,
        collateral_mint,
        system_program,
        collateral_token_program,
    )?;
    let p_bump_seed = [p_bump];
    let series_key_bytes = *series.address().as_array();
    token::create_account(payer, p_mint, token_program.address(), 82, &[
        Seed::from(crate::state::P_MINT_SEED),
        Seed::from(&series_key_bytes[..]),
        Seed::from(&p_bump_seed[..]),
    ])?;
    let n_bump_seed = [n_bump];
    token::create_account(payer, n_mint, token_program.address(), 82, &[
        Seed::from(crate::state::N_MINT_SEED),
        Seed::from(&series_key_bytes[..]),
        Seed::from(&n_bump_seed[..]),
    ])?;
    token::initialize_mint(
        token_program,
        p_mint,
        collateral_decimals,
        series.address().as_array(),
    )?;
    token::initialize_mint(
        token_program,
        n_mint,
        collateral_decimals,
        series.address().as_array(),
    )?;

    let config = SeriesConfig {
        factory: *factory_authority.address().as_array(),
        admin: *admin.address().as_array(),
        collateral_mint: *collateral_mint.address().as_array(),
        collateral_vault: *collateral_vault.address().as_array(),
        oracle_adapter: *oracle_adapter.address().as_array(),
        p_mint: *p_mint.address().as_array(),
        n_mint: *n_mint.address().as_array(),
        strike: params.strike,
        price_decimals: params.price_decimals,
        collateral_decimals,
        multiplier_at_creation,
        maturity_ts: params.maturity_ts,
        settlement_delay_secs: params.settlement_delay_secs,
        max_oracle_age_secs: params.max_oracle_age_secs,
        max_price_lag_secs: params.max_price_lag_secs,
        min_split_amount: params.min_split_amount,
        fee_bps: params.fee_bps,
        fee_recipient: *fee_recipient.address().as_array(),
        status: SeriesStatus::Open,
        bump: series_bump,
    };
    let series_key = *series.address().as_array();
    let mut series_data = series.try_borrow_mut()?;
    config.store(&mut series_data).or_program_error()?;
    drop(series_data);

    events::series_created(
        &series_key,
        &config.collateral_mint,
        &config.p_mint,
        &config.n_mint,
        config.strike,
        config.price_decimals,
        config.maturity_ts,
        multiplier_at_creation,
    );
    Ok(())
}

// --- split ------------------------------------------------------------------

fn split(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> Result<(), ProgramError> {
    let amount = read_u64(args)?;
    // holder, series, collateral_mint, collateral_vault, holder_collateral,
    // p_mint, n_mint, receiver_p, receiver_n, fee_vault?, token programs...
    if accounts.len() < 12 {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    }
    let (fixed, remaining) = accounts.split_at_mut(12);
    let [holder, series, collateral_mint, collateral_vault, holder_collateral, p_mint, n_mint, receiver_p, receiver_n, fee_vault, collateral_token_program, token_program] =
        fixed
    else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };
    // The fee vault is positional: the program id itself is the placeholder
    // for `None`, exactly as Anchor's `Option` account resolves it.
    let fee_vault = if fee_vault.address() == program_id {
        None
    } else {
        Some(&*fee_vault)
    };

    accounts::signer(holder)?;
    accounts::owned_by_program(series, program_id)?;
    let series_data = series.try_borrow()?;
    let config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    accounts::series_has_one(
        &config,
        collateral_mint,
        collateral_vault,
        p_mint,
        n_mint,
    )?;
    accounts::writable(collateral_mint)?;
    accounts::token_account_program(collateral_vault)?;
    accounts::writable(collateral_vault)?;
    accounts::token_account_is(
        holder_collateral,
        &config.collateral_mint,
        Some(holder.address().as_array()),
    )?;
    accounts::writable(holder_collateral)?;
    check_token_owner(p_mint)?;
    accounts::writable(p_mint)?;
    check_token_owner(n_mint)?;
    accounts::writable(n_mint)?;
    accounts::token_account_is(receiver_p, &config.p_mint, None)?;
    accounts::writable(receiver_p)?;
    accounts::token_account_is(receiver_n, &config.n_mint, None)?;
    accounts::writable(receiver_n)?;
    check_token_interface(collateral_token_program)?;
    check_program(token_program, &token::TOKEN_PROGRAM_ID)?;

    let now = Clock::get()?.unix_timestamp;
    logic::require_splittable(config.status, now, config.maturity_ts)?;
    let multipliers = collateral::read_multipliers(collateral_mint)?;
    collateral::require_no_scheduled_change(&multipliers, now, config.maturity_ts)?;

    require(amount > 0, OptionsError::InvalidAmount)?;
    require(
        amount >= config.min_split_amount,
        OptionsError::AmountTooSmall,
    )?;

    let (extra_buf, extra_len) = extra_views(remaining, series);
    let extra = &extra_buf[..extra_len];
    collateral::transfer_collateral(
        collateral_token_program,
        holder_collateral,
        collateral_mint,
        collateral_vault,
        holder,
        extra,
        amount,
        config.collateral_decimals,
        &[],
    )?;

    let fee = logic::fee_amount(amount, config.fee_bps)?;
    let net = amount
        .checked_sub(fee)
        .ok_or(err(OptionsError::MathUnderflow))?;
    require(net > 0, OptionsError::InvalidAmount)?;

    if fee > 0 {
        let fee_vault =
            fee_vault.ok_or(err(OptionsError::InvalidParams))?;
        accounts::writable(fee_vault)?;
        accounts::token_account_is(fee_vault, &config.collateral_mint, None)?;
        let vault_data = fee_vault.try_borrow()?;
        let owner = token::token_owner(&vault_data)?;
        drop(vault_data);
        require_keys_eq(&owner, &config.fee_recipient, OptionsError::Unauthorized)?;
        let seeds = SeriesSeeds::new(&config);
        let seeds = seeds.as_seeds();
        collateral::transfer_collateral(
            collateral_token_program,
            collateral_vault,
            collateral_mint,
            fee_vault,
            series,
            extra,
            fee,
            config.collateral_decimals,
            &seeds,
        )?;
    }

    let seeds = SeriesSeeds::new(&config);
    let seeds = seeds.as_seeds();
    token::mint_to(token_program, p_mint, receiver_p, series, net, &seeds)?;
    token::mint_to(token_program, n_mint, receiver_n, series, net, &seeds)?;

    let holder_key = *holder.address().as_array();
    let series_key = *series.address().as_array();
    events::split_executed(&series_key, &holder_key, amount, net, fee);
    Ok(())
}

// --- merge ------------------------------------------------------------------

fn merge(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
) -> Result<(), ProgramError> {
    let amount = read_u64(args)?;
    if accounts.len() < 11 {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    }
    let (fixed, remaining) = accounts.split_at_mut(11);
    let [
        holder,
        series,
        collateral_mint,
        collateral_vault,
        holder_collateral,
        p_mint,
        n_mint,
        holder_p,
        holder_n,
        collateral_token_program,
        token_program,
    ] = fixed
    else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };

    accounts::signer(holder)?;
    accounts::owned_by_program(series, program_id)?;
    let series_data = series.try_borrow()?;
    let config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    accounts::series_has_one(
        &config,
        collateral_mint,
        collateral_vault,
        p_mint,
        n_mint,
    )?;
    accounts::writable(collateral_mint)?;
    accounts::token_account_program(collateral_vault)?;
    accounts::writable(collateral_vault)?;
    accounts::token_account_is(holder_collateral, &config.collateral_mint, None)?;
    accounts::writable(holder_collateral)?;
    check_token_owner(p_mint)?;
    accounts::writable(p_mint)?;
    check_token_owner(n_mint)?;
    accounts::writable(n_mint)?;
    accounts::token_account_is(holder_p, &config.p_mint, Some(holder.address().as_array()))?;
    accounts::writable(holder_p)?;
    accounts::token_account_is(holder_n, &config.n_mint, Some(holder.address().as_array()))?;
    accounts::writable(holder_n)?;
    check_token_interface(collateral_token_program)?;
    check_program(token_program, &token::TOKEN_PROGRAM_ID)?;

    let now = Clock::get()?.unix_timestamp;
    logic::require_mergeable(config.status, now, config.maturity_ts)?;
    require(amount > 0, OptionsError::InvalidAmount)?;

    token::burn(token_program, p_mint, holder_p, holder, amount)?;
    token::burn(token_program, n_mint, holder_n, holder, amount)?;

    let seeds = SeriesSeeds::new(&config);
    let seeds = seeds.as_seeds();
    let (extra_buf, extra_len) = extra_views(remaining, series);
    let extra = &extra_buf[..extra_len];
    collateral::transfer_collateral(
        collateral_token_program,
        collateral_vault,
        collateral_mint,
        holder_collateral,
        series,
        extra,
        amount,
        config.collateral_decimals,
        &seeds,
    )?;

    let holder_key = *holder.address().as_array();
    let series_key = *series.address().as_array();
    events::merge_executed(&series_key, &holder_key, amount);
    Ok(())
}

// --- settle -----------------------------------------------------------------

fn settle(program_id: &Address, accounts: &mut [AccountView]) -> Result<(), ProgramError> {
    let [
        payer,
        series,
        settlement,
        collateral_mint,
        collateral_vault,
        p_mint,
        n_mint,
        oracle_adapter,
        price_source,
        system_program,
    ] = accounts
    else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };

    accounts::signer(payer)?;
    accounts::writable(payer)?;
    accounts::owned_by_program(series, program_id)?;
    accounts::writable(series)?;
    let series_data = series.try_borrow()?;
    let config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    accounts::series_has_one(
        &config,
        collateral_mint,
        collateral_vault,
        p_mint,
        n_mint,
    )?;
    accounts::series_has_oracle(&config, oracle_adapter)?;
    accounts::owned_by_program(
        oracle_adapter,
        &Address::new_from_array(oracle::ORACLE_ADAPTER_PROGRAM_ID),
    )?;
    accounts::mint(collateral_mint)?;
    accounts::token_account_program(collateral_vault)?;
    check_token_owner(p_mint)?;
    check_token_owner(n_mint)?;
    check_program(system_program, &token::SYSTEM_PROGRAM_ID)?;

    // The settlement account must be fresh: system-owned and empty.
    if settlement.owner() != system_program.address() || settlement.data_len() != 0 {
        return Err(err(OptionsError::InvalidParams));
    }
    let (settlement_key, settlement_bump) = find_pda(
        &[crate::state::SETTLEMENT_SEED, series.address().as_array()],
        program_id,
    );
    require_keys_eq(
        settlement.address().as_array(),
        settlement_key.as_array(),
        OptionsError::InvalidParams,
    )?;

    let now = Clock::get()?.unix_timestamp;
    logic::require_settleable(
        config.status,
        now,
        config.maturity_ts,
        config.settlement_delay_secs,
    )?;

    let p_mint_data = p_mint.try_borrow()?;
    let p_supply = token::mint_supply(&p_mint_data)?;
    drop(p_mint_data);
    let n_mint_data = n_mint.try_borrow()?;
    let n_supply = token::mint_supply(&n_mint_data)?;
    drop(n_mint_data);
    let vault_data = collateral_vault.try_borrow()?;
    let vault_balance = token::token_amount(&vault_data)?;
    drop(vault_data);
    let health = logic::assess_settlement_health(vault_balance, p_supply, n_supply);

    let feed_data = oracle_adapter.try_borrow()?;
    let feed = oracle::read_feed_config(oracle_adapter.owner().as_array(), &feed_data)?;
    let source_data = price_source.try_borrow()?;
    let quote = oracle::read_quote_at_or_after(
        &feed,
        price_source.address().as_array(),
        price_source.owner().as_array(),
        &source_data,
        now,
        config.maturity_ts,
        config.max_oracle_age_secs,
    )
    .or_program_error()?;
    drop(source_data);
    logic::require_settlement_window(
        quote.timestamp,
        config.maturity_ts,
        config.max_price_lag_secs,
    )?;

    let multipliers = collateral::read_multipliers(collateral_mint)?;
    let multiplier_at_settlement = multipliers.fixed_at(quote.timestamp)?;
    let pools = logic::compute_settlement(&logic::SettleParams {
        strike: config.strike,
        price_decimals: config.price_decimals,
        multiplier_at_creation: config.multiplier_at_creation,
        multiplier_at_settlement,
        collateral: vault_balance,
        quote_price: quote.price,
        quote_decimals: quote.decimals,
    })?;

    let settlement_bump_seed = [settlement_bump];
    let series_key = *series.address().as_array();
    token::create_account(payer, settlement, program_id, SETTLEMENT_LEN, &[
        Seed::from(crate::state::SETTLEMENT_SEED),
        Seed::from(&series_key[..]),
        Seed::from(&settlement_bump_seed[..]),
    ])?;
    let record = Settlement {
        series: *series.address().as_array(),
        price: pools.price,
        price_decimals: config.price_decimals,
        price_ts: quote.timestamp,
        settled_ts: now,
        collateral_at_settlement: vault_balance,
        p_supply_at_settlement: p_supply,
        n_supply_at_settlement: n_supply,
        p_pool: pools.p_pool,
        n_pool: pools.n_pool,
        p_redeemed: 0,
        n_redeemed: 0,
        p_paid: 0,
        n_paid: 0,
        multiplier_at_settlement,
        effective_strike: pools.effective_strike,
        shortfall_observed: health.under_collateralized,
        supply_mismatch: health.supply_mismatch,
        bump: settlement_bump,
    };
    let mut settlement_data = settlement.try_borrow_mut()?;
    record.store(&mut settlement_data).or_program_error()?;
    drop(settlement_data);

    let series_key = *series.address().as_array();
    let mut series_mut = series.try_borrow_mut()?;
    let mut updated = SeriesConfig::load(&series_mut).or_program_error()?;
    updated.status = SeriesStatus::Settled;
    updated.store(&mut series_mut).or_program_error()?;
    drop(series_mut);

    events::series_settled(
        &series_key,
        pools.price,
        config.price_decimals,
        quote.timestamp,
        vault_balance,
        pools.p_pool,
        pools.n_pool,
        pools.effective_strike,
        config.multiplier_at_creation,
        multiplier_at_settlement,
        health.supply_mismatch,
        health.under_collateralized,
    );
    Ok(())
}
// --- redeem -----------------------------------------------------------------

fn redeem(
    program_id: &Address,
    accounts: &mut [AccountView],
    args: &[u8],
    is_p_side: bool,
) -> Result<(), ProgramError> {
    let amount = read_u64(args)?;
    if accounts.len() < 10 {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    }
    let (fixed, remaining) = accounts.split_at_mut(10);
    let [
        holder,
        series,
        settlement,
        collateral_mint,
        collateral_vault,
        holder_collateral,
        claim_mint,
        holder_claim,
        collateral_token_program,
        token_program,
    ] = fixed
    else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };

    accounts::signer(holder)?;
    accounts::owned_by_program(series, program_id)?;
    let series_data = series.try_borrow()?;
    let config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    // Only the retiring side's mint is bound; the sibling side is absent by
    // construction, exactly as the Anchor context omits it.
    let expected_mint = if is_p_side {
        &config.p_mint
    } else {
        &config.n_mint
    };
    require_keys_eq(
        collateral_mint.address().as_array(),
        &config.collateral_mint,
        OptionsError::InvalidParams,
    )?;
    require_keys_eq(
        collateral_vault.address().as_array(),
        &config.collateral_vault,
        OptionsError::InvalidParams,
    )?;
    require_keys_eq(
        claim_mint.address().as_array(),
        expected_mint,
        OptionsError::InvalidParams,
    )?;
    accounts::owned_by_program(settlement, program_id)?;
    let settlement_data = settlement.try_borrow()?;
    let record = Settlement::load(&settlement_data).or_program_error()?;
    drop(settlement_data);
    // The settlement PDA re-derived with the bump it recorded — `create`,
    // never `find`, so only the recorded bump validates.
    let series_key = *series.address().as_array();
    let bump_seed = [record.bump];
    let expected_settlement = Address::create_program_address(
        &[crate::state::SETTLEMENT_SEED, &series_key, &bump_seed],
        program_id,
    )
    .map_err(|_| err(OptionsError::InvalidParams))?;
    require_keys_eq(
        settlement.address().as_array(),
        expected_settlement.as_array(),
        OptionsError::InvalidParams,
    )?;
    require_keys_eq(
        &record.series,
        &series_key,
        OptionsError::InvalidParams,
    )?;
    accounts::writable(settlement)?;
    accounts::writable(collateral_mint)?;
    accounts::token_account_program(collateral_vault)?;
    accounts::writable(collateral_vault)?;
    accounts::token_account_is(holder_collateral, &config.collateral_mint, None)?;
    accounts::writable(holder_collateral)?;
    check_token_owner(claim_mint)?;
    accounts::writable(claim_mint)?;
    accounts::token_account_is(
        holder_claim,
        expected_mint,
        Some(holder.address().as_array()),
    )?;
    accounts::writable(holder_claim)?;
    check_token_interface(collateral_token_program)?;
    check_program(token_program, &token::TOKEN_PROGRAM_ID)?;

    require(
        config.status == SeriesStatus::Settled,
        OptionsError::NotSettled,
    )?;

    let (pool, supply) = if is_p_side {
        (record.p_pool, record.p_supply_at_settlement)
    } else {
        (record.n_pool, record.n_supply_at_settlement)
    };
    let vault_data = collateral_vault.try_borrow()?;
    let vault_balance = token::token_amount(&vault_data)?;
    drop(vault_data);
    let payout = logic::redeem_payout(amount, pool, supply, record.outstanding(), vault_balance)?;

    token::burn(token_program, claim_mint, holder_claim, holder, amount)?;

    let mut settlement_mut = settlement.try_borrow_mut()?;
    let mut updated = Settlement::load(&settlement_mut).or_program_error()?;
    if is_p_side {
        updated.p_redeemed = updated
            .p_redeemed
            .checked_add(payout.quoted)
            .ok_or(err(OptionsError::MathOverflow))?;
        updated.p_paid = updated
            .p_paid
            .checked_add(payout.paid)
            .ok_or(err(OptionsError::MathOverflow))?;
        require(
            updated.p_redeemed <= updated.p_pool,
            OptionsError::InsufficientCollateral,
        )?;
    } else {
        updated.n_redeemed = updated
            .n_redeemed
            .checked_add(payout.quoted)
            .ok_or(err(OptionsError::MathOverflow))?;
        updated.n_paid = updated
            .n_paid
            .checked_add(payout.paid)
            .ok_or(err(OptionsError::MathOverflow))?;
        require(
            updated.n_redeemed <= updated.n_pool,
            OptionsError::InsufficientCollateral,
        )?;
    }
    if payout.shortfall {
        updated.shortfall_observed = true;
    }
    updated.store(&mut settlement_mut).or_program_error()?;
    drop(settlement_mut);

    let seeds = SeriesSeeds::new(&config);
    let seeds = seeds.as_seeds();
    let (extra_buf, extra_len) = extra_views(remaining, series);
    collateral::transfer_collateral(
        collateral_token_program,
        collateral_vault,
        collateral_mint,
        holder_collateral,
        series,
        &extra_buf[..extra_len],
        payout.paid,
        config.collateral_decimals,
        &seeds,
    )?;

    let holder_key = *holder.address().as_array();
    events::redeemed(
        &series_key,
        &holder_key,
        is_p_side,
        amount,
        payout.quoted,
        payout.paid,
    );
    if payout.shortfall {
        events::shortfall_observed(&series_key, payout.quoted, payout.paid);
    }
    Ok(())
}

// --- admin ------------------------------------------------------------------

fn pause_splits(
    program_id: &Address,
    accounts: &mut [AccountView],
    pause: bool,
) -> Result<(), ProgramError> {
    let [admin, series] = accounts else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };
    accounts::signer(admin)?;
    accounts::owned_by_program(series, program_id)?;
    accounts::writable(series)?;
    let series_data = series.try_borrow()?;
    let mut config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    accounts::series_has_admin(&config, admin)?;
    if pause {
        require(
            config.status == SeriesStatus::Open,
            OptionsError::SeriesClosed,
        )?;
        config.status = SeriesStatus::Paused;
    } else {
        require(
            config.status == SeriesStatus::Paused,
            OptionsError::SeriesClosed,
        )?;
        config.status = SeriesStatus::Open;
    }
    let series_key = *series.address().as_array();
    let mut series_mut = series.try_borrow_mut()?;
    config.store(&mut series_mut).or_program_error()?;
    drop(series_mut);
    events::splits_paused(&series_key, pause);
    Ok(())
}

fn renounce_admin(program_id: &Address, accounts: &mut [AccountView]) -> Result<(), ProgramError> {
    let [admin, series] = accounts else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };
    accounts::signer(admin)?;
    accounts::owned_by_program(series, program_id)?;
    accounts::writable(series)?;
    let series_data = series.try_borrow()?;
    let mut config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    accounts::series_has_admin(&config, admin)?;
    // One way: afterwards no signer can match the zero address, and the
    // pause and dust paths are dead for the life of the series.
    config.admin = [0u8; 32];
    let series_key = *series.address().as_array();
    let mut series_mut = series.try_borrow_mut()?;
    config.store(&mut series_mut).or_program_error()?;
    drop(series_mut);
    events::admin_renounced(&series_key);
    Ok(())
}

fn sweep_dust(program_id: &Address, accounts: &mut [AccountView]) -> Result<(), ProgramError> {
    if accounts.len() < 8 {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    }
    let (fixed, remaining) = accounts.split_at_mut(8);
    let [
        admin,
        series,
        collateral_mint,
        collateral_vault,
        fee_vault,
        p_mint,
        n_mint,
        collateral_token_program,
    ] = fixed
    else {
        return Err(framework_error(framework_code::NOT_ENOUGH_KEYS));
    };

    accounts::signer(admin)?;
    accounts::owned_by_program(series, program_id)?;
    let series_data = series.try_borrow()?;
    let config = SeriesConfig::load(&series_data).or_program_error()?;
    drop(series_data);
    accounts::series_has_admin(&config, admin)?;
    accounts::series_has_one(
        &config,
        collateral_mint,
        collateral_vault,
        p_mint,
        n_mint,
    )?;
    accounts::writable(collateral_mint)?;
    accounts::token_account_program(collateral_vault)?;
    accounts::writable(collateral_vault)?;
    accounts::token_account_is(fee_vault, &config.collateral_mint, None)?;
    accounts::writable(fee_vault)?;
    check_token_owner(p_mint)?;
    check_token_owner(n_mint)?;
    check_token_interface(collateral_token_program)?;

    require(
        config.status == SeriesStatus::Settled,
        OptionsError::NotSettled,
    )?;
    let p_mint_data = p_mint.try_borrow()?;
    let p_supply = token::mint_supply(&p_mint_data)?;
    drop(p_mint_data);
    let n_mint_data = n_mint.try_borrow()?;
    let n_supply = token::mint_supply(&n_mint_data)?;
    drop(n_mint_data);
    require(
        p_supply == 0 && n_supply == 0,
        OptionsError::DustSweepTooEarly,
    )?;
    let fee_vault_data = fee_vault.try_borrow()?;
    let fee_owner = token::token_owner(&fee_vault_data)?;
    drop(fee_vault_data);
    require_keys_eq(&fee_owner, &config.fee_recipient, OptionsError::Unauthorized)?;

    let vault_data = collateral_vault.try_borrow()?;
    let remaining_balance = token::token_amount(&vault_data)?;
    drop(vault_data);

    let seeds = SeriesSeeds::new(&config);
    let seeds = seeds.as_seeds();
    let (extra_buf, extra_len) = extra_views(remaining, series);
    collateral::transfer_collateral(
        collateral_token_program,
        collateral_vault,
        collateral_mint,
        fee_vault,
        series,
        &extra_buf[..extra_len],
        remaining_balance,
        config.collateral_decimals,
        &seeds,
    )?;

    let series_key = *series.address().as_array();
    events::dust_swept(&series_key, remaining_balance);
    Ok(())
}
