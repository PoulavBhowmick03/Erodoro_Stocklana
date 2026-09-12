# Every Anchor constraint, and where the Pinocchio port enforces it

`#[derive(Accounts)]` generates the ownership, signer, writable, PDA and
`has_one` checks. The Pinocchio ports generate nothing, so each one is written
by hand — and **those checks are the security model**. This file exists so that
claim can be checked rather than believed.

It is **not** an audit. It is the mapping an auditor would otherwise have to
reconstruct: for every constraint in the Anchor build, the line in the port that
carries it, or an explicit note that nothing does and why.

## How to read the columns

- **Enforced by** — the hand-written check, or the CPI callee that rejects it.
- **Stricter** — the port refuses something Anchor accepts. Safe here, but a
  behavioural difference and therefore worth knowing.
- **Delegated** — no local check; a CPI target rejects it. Sound, because the
  callee is the authority, but it means the error a caller sees differs.

---

## `factory` → `variants/factory-pinocchio/src/lib.rs`

### `Initialize`

| Anchor | Enforced by |
| --- | --- |
| `payer: Signer` + `mut` | `accounts::signer` / `accounts::writable` |
| `admin: Signer` | `accounts::signer` |
| `factory: init, seeds = [FACTORY_SEED], bump` | `find_program_address` compared to the passed address, then `create_pda` signs with the derived bump |
| `space = 8 + FactoryState::INIT_SPACE` | `FACTORY_STATE_LEN`, asserted equal to Anchor's `INIT_SPACE` in `tests/conformance.rs` |
| `system_program: Program<System>` | **Delegated.** `pinocchio_system::CreateAccount` targets the real system program by id, so a forged account is inert rather than dangerous |

### `AdminOnly` (`set_admin`, `pause_creation`, `unpause_creation`)

| Anchor | Enforced by |
| --- | --- |
| `admin: Signer` | `load_admin_only` → `accounts::signer` |
| `factory: mut` | `accounts::writable` |
| `has_one = admin` | `accounts::has_admin`, comparing the stored admin to the signer |
| `seeds = [FACTORY_SEED], bump = factory.bump` | `accounts::pda_with_bump`, re-deriving with the **stored** bump — `create_program_address`, not `find` |

### `ApproveOracle` / `ApproveCollateral`

| Anchor | Enforced by |
| --- | --- |
| `payer: Signer` + `mut` | `approve()` |
| `factory: has_one = admin, seeds` — note **no `mut`** | `load_admin_only`; `approve()` deliberately does not require writable |
| `feed_config: Account<FeedConfig>` | `accounts::feed_config` — owner is `oracle_adapter`, and the discriminator matches |
| `collateral_mint: InterfaceAccount<Mint>` | `accounts::mint` — owner is SPL Token or Token-2022, and length ≥ 82 |
| `approval: init, seeds = [SEED, target.key()], bump` | derived from the **validated** target, then `create_pda` |
| re-approving an existing entry | **Delegated.** System `CreateAccount` fails on an account that already holds lamports, which is what Anchor's `init` relies on too |

### `RevokeOracle` / `RevokeCollateral`

| Anchor | Enforced by |
| --- | --- |
| `admin: Signer`, `factory: has_one = admin` | `load_admin_only` |
| `rent_recipient: mut` | `accounts::writable` |
| `approval: mut, close = rent_recipient` | lamports moved to the recipient, then `AccountView::close` |
| `seeds = [SEED, approval.target.as_ref()], bump = approval.bump` | `accounts::pda_with_bump` over the target **read from the account**, not one the caller supplies — so one approval cannot be closed by presenting another's target |

### `CreateSeries`

| Anchor | Enforced by |
| --- | --- |
| `payer: Signer` + `mut` | `accounts::signer` / `writable` |
| `factory: mut, has_one = admin, seeds` | `accounts::writable` + `load_admin_only` |
| `!factory.paused` | checked before anything is written |
| `oracle_approval: seeds = [ORACLE_SEED, feed_config.key()], bump` | `accounts::pda_with_bump`. Existence at the right address *is* the approval; nothing reads `target`, matching the Anchor build |
| `collateral_approval: seeds = [COLLATERAL_SEED, collateral_mint.key()], bump` | as above |
| `feed_config: Box<Account<FeedConfig>>` | `accounts::feed_config` |
| `collateral_mint: mint::token_program = collateral_token_program` | `accounts::mint_token_program` |
| `series`, `collateral_vault`, `p_mint`, `n_mint`: `mut`, unchecked | `accounts::writable` on each; their contents are the callee's business |
| `record: init, seeds = [RECORD_SEED, series.key()], bump` | derived and compared, then `create_pda` |
| `series_program: Program<Series>` | `accounts::program` against `SERIES_ID` |
| `token_program`, `associated_token_program`, `system_program` | **Delegated** to `series::create_series`, which declares each as `Program<'info, T>` and rejects a forgery |
| the CPI's account order and signer/writable flags | `series_cpi::create_series`, with the payload proven byte-identical to `anchor_lang`'s under proptest |

---

## `market` → `variants/market-pinocchio/src/program.rs`

### `InitializeMarket`

| Anchor | Enforced by |
| --- | --- |
| `payer: Signer` + `mut` | `accounts::signer` / `writable` |
| `series: UncheckedAccount` | none, matching Anchor — it is a PDA seed and an identifier, never an authority |
| `market: init, seeds = [MARKET_SEED, series.key()], bump` | derived and compared, then `create_pda` |
| `p_mint`, `n_mint`, `quote_mint`: `Account<Mint>` | **Delegated.** The ATA program rejects a non-mint when each vault is created, so a forgery cannot survive the instruction |
| the three vaults: `init, associated_token::mint/authority` | the ATA program derives the address itself and rejects any other, which is the check Anchor's constraint leans on; `accounts::writable` on each locally |
| `token_program`, `associated_token_program` | `accounts::key_is` against the canonical ids |
| `require_open_at(maturity, now)` | checked before the market is written |

### `InitializeBook`

| Anchor | Enforced by |
| --- | --- |
| `payer: Signer` + `mut` | `accounts::signer` / `writable` |
| `market: Box<Account<Market>>` | `load_market` — owner, discriminator, **and** the PDA seeds |
| `book: init, seeds = [BOOK_SEED, market.key(), leg.tag()], bump` | derived and compared, then `create_pda` |
| `require_open` | via `load_market` + `require_open` |

**Stricter:** `load_market` re-derives the market's PDA. Anchor's `Deposit`,
`Withdraw` and `Trade` contexts check only owner, discriminator and `has_one`,
with no `seeds` constraint on `market`. Since `initialize_market` only ever
creates a market at its PDA, no real market can fail the stricter check.

### `Deposit` / `Withdraw`

| Anchor | Enforced by |
| --- | --- |
| `trader: Signer` | `accounts::signer` |
| `market: has_one = quote_vault` | `check_vaults` → `accounts::key_is(quote_vault, market.quote_vault)` |
| `book: mut, has_one = market` | `accounts::writable` + `check_book`, which also re-derives the book's seeds from the market and leg |
| `constraint = base_vault.key() == market.base_vault(book.leg)` | `check_vaults`, using the leg read from the book — this is what stops N being deposited against the P book |
| `base_vault`, `quote_vault`, `trader_base`, `trader_quote`: `mut` | `accounts::writable` on all four |
| deposit: `token::authority = trader` | `accounts::token_account_is(.., Some(trader), ..)` |
| withdraw: no authority constraint | matched — `None` is passed, because the trader names their own destination and the slot debit is what authorises it |
| `token::mint = <vault>.mint` | `accounts::token_account_is` against the mint read from the vault |
| `token_program: Program<Token>` | `token::transfer` refuses anything but the canonical id |
| withdraw signs as the market PDA | `Seed`s from `MARKET_SEED, series, bump` |

**Ordering:** the ledger is written before the transfers, because the account
borrow has to be released before a CPI. A failed transfer reverts the whole
instruction, so the ledger cannot outrun the tokens.

### `Trade` (`place_order`, `cancel_order`, `fill_order`)

| Anchor | Enforced by |
| --- | --- |
| `trader: Signer` | `trade_accounts` |
| `market: Box<Account<Market>>` | `load_market` |
| `book: mut, has_one = market` | `accounts::writable` + `check_book` |
| `require_open` on place and fill, **not** on cancel | matched exactly — cancelling has to work after maturity |

### `DelegateBook` / `CommitBook`

| Anchor | Enforced by |
| --- | --- |
| `payer: Signer` | `accounts::signer` |
| `book: mut, del` — **UncheckedAccount** | `accounts::writable`, plus the book's PDA re-derived from the market and leg |
| the buffer PDA | derived as `[b"buffer", book.key()]` under this program and compared |
| `delegation_program`, `magic_program`, `magic_context` | `accounts::key_is` against the SDK's own constants, which `tests/delegation_wire.rs` asserts match |
| the instruction payloads | rebuilt in `src/delegation.rs`, every byte compared against the SDK's own serialisation |

**Stricter:** Anchor takes `book` as an `UncheckedAccount` and does not check it
belongs to the market being delegated. The port derives and compares it.

---

## `series` → `variants/series-pinocchio/src/accounts.rs` — **in progress**

The state layer and the check primitives exist; the ten instruction handlers do
not. Rows below are the primitives, not a claim that any instruction uses them
yet.

| Anchor | Enforced by |
| --- | --- |
| `Account<'info, SeriesConfig>` / `Settlement` | `owned_by_program` + the discriminator inside `SeriesConfig::load` / `Settlement::load` |
| `Signer<'info>` | `signer` |
| `#[account(mut)]` | `writable` |
| `has_one = collateral_mint / collateral_vault / p_mint / n_mint` | `series_has_one`, which takes all four at once so adding an account to a context without checking it is a compile error rather than a silent gap |
| `has_one = oracle_adapter` | `series_has_oracle` — only `settle` carries it |
| `has_one = admin` | `series_has_admin` |
| `seeds = [..], bump = <stored>` | `pda_with_bump`, `create_program_address` with the stored bump |
| `token::mint = m` | `token_account_is(.., mint, None)` |
| `token::authority = a` | `token_account_is(.., mint, Some(a))` — passed `None` wherever Anchor omits it, which is as important to copy as the checks |
| `InterfaceAccount<'info, Mint>` | `mint` |
| `mint::token_program = p` | `mint_token_program` |
| `Program<'info, T>` | `program` |
| the settlement arithmetic | **not reimplemented.** `common::math` is linked, so `compute_pools`, `compute_redeem`, `apply_shortfall` and `effective_strike` are the same code the Anchor build calls |
| error codes | `error::err` applies Anchor's 6000 offset; checked against Anchor's own conversion for 20 variants |

---

## `oracle-adapter` → `variants/oracle-adapter-pinocchio/src/lib.rs`

| Anchor | Enforced by |
| --- | --- |
| `Account<'info, FeedConfig>` | `accounts::owned_by_program` + the discriminator inside `FeedConfig::load` |
| `Signer` | `accounts::signer` |
| `#[account(mut)]` | `accounts::writable` |
| `has_one = admin` | `accounts::has_admin` |
| `seeds = [FEED_CONFIG_SEED, feed_id], bump` | `find_program_address` against the **runtime** `program_id` |

---

## What this file does not establish

- That the Anchor builds are themselves correct. Every row above says the port
  matches the original; none of them says the original is safe. Three *high*
  severity findings in `SECURITY.md` came out of reviewing those originals, and
  that review was internal.
- That the delegated checks are sufficient. Rows marked **Delegated** are sound
  only while the callee keeps rejecting what it rejects today.
- That the ports behave identically at runtime. The differential suites cover
  layouts, discriminators, error codes, engine state and the CPI payloads;
  `make pinocchio-{oracle,factory,market}` execute them. Neither reaches the
  four delegation instructions, which nothing executes automatically.
