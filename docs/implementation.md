# erodoro: what was built

> **Historical implementation record.** This file predates the current
> Pyth-only oracle adapter and the `market` program. Its test counts, commands,
> architecture diagram, and deployment status are not a current release
> checklist. Use `README.md`, `Makefile`, and `deployments/devnet.json` for the
> current repository state.

Implementation record. Bracketed § numbers refer to sections of the internal
design note. This document describes what exists, where the design turned out
to be wrong, and what the tests actually prove.

## Status

| Build-order step [§13] | State |
| --- | --- |
| 1. Port `common` | Done. Math ports verbatim; fixtures re-based to 8 decimals. |
| 2. Port `series` against mock SPL collateral | Done. |
| 3. Swap in Token-2022 | Done. `token_interface`, `transfer_checked`, hook-aware account resolution. |
| 4. Add the multiplier logic [§6] | Done, both split directions tested on a validator. |
| 5. Add the shortfall haircut [§7] | Done, tested against a real permanent-delegate drain. |
| 6. Port `oracle-adapter` onto Pyth | Done. Decoder verified against a live account, adapter reads production Pyth on devnet, and a series settles against real `PriceUpdateV2` bytes. |
| 7. Port `factory` | Done. |
| 8. Devnet with a mock TSLAx | Partial — oracle layer deployed and tested; `series`/`factory` blocked on devnet SOL. |
| 9. Mainnet drill | Not started. |

## Architecture

Four deployable programs plus a shared library.

```
factory ──CPI──> series ──reads──> oracle-adapter::FeedConfig
                   │                      │
                   ├─ collateral vault    └──> Pyth PriceUpdateV2
                   │  (ATA, Token-2022)         or mock-oracle::MockFeed
                   ├─ P mint (SPL Token, authority = series PDA)
                   └─ N mint (SPL Token, authority = series PDA)
```

`common/` sits at the workspace root, not under `programs/`, because
`anchor build` treats every directory there as a deployable program. It depends
on `anchor-lang` for exactly two things: `#[error_code]` on `OptionsError`, so
a math failure converts to a program error without a per-call-site `map_err`,
and the serialization derives on the shared types.

### The oracle adapter is a library, not a CPI target

The price account must be in the transaction anyway, so a CPI would buy
nothing but compute units. Instead the adapter *owns* `FeedConfig` accounts — which is what
makes a feed's identity tamper-evident — and exports `read_quote_at_or_after`
as a plain function that `series` links in with `features = ["no-entrypoint"]`.
Anchor's owner check on `Account<'info, FeedConfig>` is what ties the two
together. Same shape `sidereal.sol` uses for `sy_wrapper::Vault`.

### PDAs

| Account | Seeds |
| --- | --- |
| `SeriesConfig` | `["series", collateral_mint, strike_le_i128, maturity_le_i64]` |
| `Settlement` | `["settlement", series]` |
| P mint | `["p-mint", series]` |
| N mint | `["n-mint", series]` |
| collateral vault | ATA of `collateral_mint` owned by the series PDA |
| `FeedConfig` | `["feed-config", feed_id]` |
| `FactoryState` | `["factory"]` |
| oracle / collateral approval | `["approved-oracle", feed_config]`, `["approved-collateral", mint]` |
| `SeriesRecord` | `["record", series]` |

Seeding the series on its own parameters means the mints can name the series
PDA as their authority at creation, because the address is derivable before the
account exists.

Creating a series is permissionless. What makes a series *canonical* is the
factory's registry. **Front ends must list from `SeriesRecord`, never from the
`series` program's accounts at large.**

## The payoff

The whole product, in three lines:

```
price <= strike:  p_pool = collateral,                     n_pool = 0
price >  strike:  p_pool = floor(collateral*strike/price), n_pool = collateral - p_pool
payout           = floor(amount * pool / supply_at_settlement)
```

Two rounding conventions run through the whole system, both deliberate and
both asserted in tests rather than left to emerge:

1. **Payouts floor.** `total_paid <= collateral_locked` for any redemption order.
2. **Rounding favours P.** P is the senior claim. Flooring the normalized price
   rounds `p_pool` up; ceiling the effective strike does the same.

## The five problems

### Corporate actions [§6]

The mechanism the plan predicted is real and readable: Token-2022's
`ScaledUiAmountConfig` carries a multiplier, a scheduled replacement, and the
timestamp the replacement takes effect. Settlement derives

```
effective_strike = ceil(strike * multiplier_at_creation / multiplier_at_settlement)
```

and never mutates the stored strike. Three details the plan called for and that
matter more than they look:

- **The multiplier is resolved as of the price timestamp, not the clock.** A
  corporate action landing between the print and the `settle` transaction has
  not happened yet from that price's point of view. `spl-token-2022` 8.0's own
  `current_multiplier` uses the same `>= new_multiplier_effective_timestamp`
  rule, which confirms the semantics.
- **Creation refuses a series that would span a known scheduled change.**
  `require_no_scheduled_change` compares the effective multiplier at `now`
  against the one at `maturity_ts`; if they differ, the operator has to pick a
  different maturity.
- **Both multipliers and the derived strike are stored in `Settlement`**, so
  any payout can be audited after the fact.

The plan types `multiplier_at_creation` as `u64`. The extension stores an
`f64`. Floating point has no place in a settlement calculation, so it is
converted once at the edge to a `1e12`-scaled integer and never touched as a
float again; non-finite, non-positive and absurdly large values are rejected
rather than settled against.

Verified on a validator: a 2-for-1 split landing mid-series, with the feed
moving from $600 to $300, leaves `p_pool` and `n_pool` bit-identical to the
unsplit case. Without the adjustment the same event drives the price under the
stored strike and sets `n_pool` to zero — N wiped out by an event in which
nobody lost any money.

**Still open:** a cash dividend passed through by rebasing is not a clean
ratio, and the strike adjustment cannot express it. Either avoid series
spanning a known ex-dividend date or state plainly that dividends accrue to P.
The refusal above is the conservative half of that answer, not all of it.

### The issuer can drain a settled vault [§7]

`permanentDelegate` lets Backed move collateral out of the vault after
settlement, and no contract check can prevent it. Redemption therefore prices
the shortfall instead of gating it:

```
available = vault_balance
expected  = (p_pool - p_redeemed) + (n_pool - n_redeemed)
payout    = floor(quoted * available / expected)      when available < expected
```

`expected` tracks the *quoted claim outstanding*, not the original pools, which
is what keeps the ratio stable as redemptions proceed. `p_redeemed` accordingly
counts quoted claim retired; `p_paid` counts collateral actually transferred.
The two diverge exactly when the vault has been drained, which makes a haircut
auditable directly rather than inferred. A `ShortfallObserved` event fires so
the condition is visible on-chain rather than guessed at from a payout that
came up short.

Verified on a validator with a real permanent delegate: two holders, unequal
arrival order, half the vault seized after settlement. First and last redeemer
on each side are paid within 2 raw units of each other, and the total never
exceeds what the vault held.

### Settlement must land on a real market print [§8]

See [Pyth](#pyth-has-no-trading-status-8) — the plan's premise does not hold,
and this is met structurally instead.

### The transfer hook is dormant, not absent [§9]

Built for the armed case from day one, as the plan requires. Every collateral
movement goes through `spl_token_2022::onchain::invoke_transfer_checked`, which
resolves the hook program and its extra account metas from
`additional_accounts` and builds the full instruction; callers pass
`ctx.remaining_accounts` straight through. With no hook armed the list is
empty and it is an ordinary `transfer_checked`.

The `pausableConfig` needs no code: a paused mint makes transfers revert, so
`split`, `merge` and `redeem_*` fail loudly. `settle` moves no tokens, so a
series can still be settled while the mint is paused and redemptions resume
when it unpauses. That is the right behaviour and the UI should say so, or a
pause will read as a loss.

**This is the one invariant not yet proven.** See [Tests](#what-the-tests-prove).

### Decimals and price scaling [§10]

`collateral_decimals` is read off the mint at creation, stored, and passed to
every `transfer_checked` — so a mint whose decimals do not match the config
fails loudly instead of moving the wrong amount. `price_decimals` is set
explicitly per series and never inferred. Pyth's signed exponent is converted
by `scale_from_expo`: a negative exponent maps straight across, a non-negative
one is materialized at zero decimals rather than claiming precision it does not
have.

## Where the plan was wrong

### Pyth has no trading status [§8]

The plan assumes Pyth equity feeds publish a trading status settlement can gate
on. That is true of Hermes metadata and of the legacy pythnet price account,
but **not of `PriceUpdateV2`**, the account the Solana receiver actually
writes. It carries `feed_id`, `price`, `conf`, `exponent`, `publish_time`,
`prev_publish_time`, `ema_price`, `ema_conf` — and nothing about whether the
market was open.

The requirement is met structurally instead. `SeriesConfig` carries
`max_price_lag_secs`, and a quote may only settle a series if its publish time
lands in `[maturity_ts, maturity_ts + max_price_lag_secs]`. With `maturity_ts`
placed at a real market close, that is what keeps a 03:00 Sunday print out.
The window is computed off-chain per maturity and frozen at creation, which
keeps a trading calendar, market holidays and US daylight-saving transitions
off-chain — all three of which would otherwise have to live in the program and
be upgradeable, which is worse.

`MarketStatus` stays in the interface because the mock source does report one —
which is what makes the closed-market rejection testable — and because a future
source may. The adapter refuses a `Pyth` config with `require_market_open` set,
since that combination could never settle.

### The Pyth SDK is unusable here

`pyth-solana-receiver-sdk`'s transitive `pythnet-sdk` derives Anchor traits
while depending on borsh 1.x, so it only compiles when Cargo hands it
anchor-lang 1.x. This workspace pins anchor-lang 0.31.1, and Cargo unifies
`pythnet-sdk` onto that same version — whose derives emit `borsh::maybestd`
paths that borsh 1.x removed. The build then succeeds or fails depending on the
order the lockfile was generated in, which is not a dependency worth having.

`programs/oracle-adapter/src/pyth.rs` mirrors the account layout instead, with
two properties that make the mirror trustworthy. It is **derived, not
offset-based**: `VerificationLevel` is a borsh enum encoding to one byte for
`Full` and two for `Partial`, so every field after it shifts, and anything
reading fixed offsets is wrong for one of the two cases. And it is **pinned to
golden vectors from the real SDK** — byte-for-byte output of
`pyth-solana-receiver-sdk` 2.0.0 for both verification levels, with a
round-trip test asserting re-encoding reproduces those exact bytes.

The mirror also adds something the plan did not ask for: `FeedConfig` carries
`min_verification_signatures`, and a partially-verified update below that floor
is rejected. A `Partial { num_signatures: 1 }` update is cheap to post and
correspondingly cheap to forge.

### `scaledUiAmount` is not in the spl-token-2022 anchor-spl ships

anchor-spl 0.31.1 pulls `spl-token-2022` 6.0, which predates the extension
entirely — the module does not exist there. `series` depends on 8.0 directly.
Both versions coexist; they never exchange types, only `AccountInfo`.

### The bundled Solana toolchain cannot build the graph

Platform-tools v1.51 (solana-cli 3.0.13) ships rustc 1.84.1. Several crates
reached transitively through `borsh-derive → proc-macro-crate → toml_edit`, and
through `blake3`, now require edition 2024, stabilized in 1.85. v1.52+ ships
rustc 1.89 and builds it as-is.

Pinning those crates down was tried and abandoned: the chain regenerates on
every `cargo update` — `ctutils`, then `hashbrown`, then `toml_datetime`, then
`toml_parser` — and pinning build-time proc-macro dependencies to stale
versions trades one maintenance problem for a worse one.

### Two smaller notes

`Settlement` gains `p_paid`/`n_paid` beyond the three fields §11 lists, for the
reason given under [§7](#the-issuer-can-drain-a-settled-vault-7). And the
factory keeps no separate index account: `getProgramAccounts` enumerates
`SeriesRecord`s directly, with the sequential index kept inside the record for
stable ordering.

## Instructions

**`series`** — `create_series`, `split`, `merge`, `settle`, `redeem_p`,
`redeem_n`, `pause_splits`, `unpause_splits`, `sweep_dust`.

`settle` is permissionless and callable exactly once. Anyone can poke it;
nobody can choose the price.

The admin surface is deliberately minimal: pause and unpause splits, and sweep
dust once both supplies are zero. It cannot touch active collateral, cannot
settle, and cannot change any term of the series. `merge` works while `Paused`,
so a pause stops new risk without trapping collateral behind existing claims.

**`oracle-adapter`** — `initialize_feed_config`, `set_source`, `set_admin`,
`preview_quote`. The feed id is deliberately not settable: a config that could
be repointed at a different asset would let an admin change what a live series
settles against.

**`factory`** — `initialize`, `set_admin`, `pause_creation`,
`unpause_creation`, `approve_oracle`, `revoke_oracle`, `approve_collateral`,
`revoke_collateral`, `create_series`.

**`mock-oracle`** — `initialize_feed`, `push_price`, `set_status`. Test only.

## What the tests prove

Four tiers, 102 tests.

**79 native tests** (`cargo test --workspace`, no validator). All decision logic
lives in pure functions, so the §12 invariants run on the host in well under a
second. Includes property tests over the pool partition, the redemption
partition, decimal round-trips, the corporate-action adjustment, and the
shortfall haircut.

**12 end-to-end tests** on a local validator (`make e2e`) —
Anchor's account constraints, the factory→series CPI, and real Token-2022
collateral with `scaledUiAmount` and `permanentDelegate` both active.

**1 Pyth settlement test** (`make e2e-pyth`) — a series settling against the
genuine sponsored SOL/USD `PriceUpdateV2` account, loaded into a validator with
only its publish time shifted forward.

**10 devnet tests** (`make devnet`) against deployed programs — real rent, real
RPC round-trips of the account layouts, the cluster clock driving the freshness
and future-quote checks, and a live read off production Pyth.

Against the §12 matrix:

| # | Invariant | Where |
| --- | --- | --- |
| 1 | `p_supply == n_supply` outside settlement | native + e2e |
| 2 | `collateral >= p_supply` before settlement freezes | native |
| 3 | `p_pool + n_pool == collateral_at_settlement` | native + property + e2e |
| 4 | `p_redeemed <= p_pool`, `n_redeemed <= n_pool` | native + e2e |
| 5 | Total paid never exceeds collateral, any order | native + property + e2e |
| 6 | `merge` works `Open`/`Paused`, never `Settled` | native + e2e |
| 7 | `settle` callable once, only after maturity + delay | native + e2e |
| 8 | Multiplier change leaves `p_pool` unchanged (2:1, 1:2) | native + e2e |
| 9 | Scheduled multiplier applied by price timestamp | native |
| 10 | Post-settlement drain haircuts every redeemer equally | native + e2e |
| 11 | Settlement rejected against a closed-market quote | native + e2e + devnet |
| 12 | Collateral moves with the hook unset **and armed** | native + e2e |
| 13 | Decimal round-trips, flooring favours P | native + devnet |

All thirteen are covered. Case 12 needed its own program:
`programs/test-transfer-hook` implements the interface and counts its
executions, so the tests assert both that every collateral movement succeeded
and that the hook actually ran — a path that silently bypassed it would satisfy
the first and be wrong. The negative is asserted too: omitting the resolved
hook accounts fails the transfer.

## Building

Requires platform-tools v1.52+.

```sh
make test     # 74 native tests
make build    # SBF artifacts -> target/deploy/*.so
make idl      # IDLs -> target/idl/*.json

anchor test --skip-build                     # 9 e2e tests on a local validator
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json pnpm devnet   # 8 devnet tests
```

`cargo build-sbf` at the workspace root produces near-empty artifacts for
`series`, `oracle-adapter` and `mock-oracle`: the factory depends on them with
`cpi`/`no-entrypoint`, and Cargo unifies that feature across a single
invocation, stripping their entrypoints. Anchor builds each program in its own
invocation, which is why `make build` uses it.

## Deployed

Devnet, see `deployments/devnet.json`:

| Program | Address |
| --- | --- |
| `mock_oracle` | `E6s3XW87BdPpN1vcQePvhEARhw4A3QfqYh2ncDdTsDiQ` |
| `oracle_adapter` | `FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz` |

`series` and `factory` are **not** deployed. Together they need about 5.9 SOL
of rent-exempt balance and the devnet faucet is rate-limited; the wallet held
4.33 SOL, of which 3.04 went to the two programs above. Their lifecycle is
covered by the localnet suite, which exercises the same binaries.

## Not done

- **A live Pyth feed.** The decoder is byte-verified against the SDK, but no
  series has settled against a real `PriceUpdateV2` on any cluster.
- **`series`/`factory` on devnet**, pending SOL.
- **The §14 decisions.** Whether the admin survives at all; the dividend
  policy; which ticker first, chosen on P/N order-book depth rather than the
  popularity of the underlying. And the one that no contract solves: where N
  liquidity comes from. The contract works with zero traders; the product does
  not.

## Before mainnet [§15]

Everything about the collateral mint is mutable by the issuer and was observed
on 2026-08-13. Re-read all five extensions immediately before deployment.

- `transferHook.programId` still unset, or the armed hook permits the vault PDA.
- The multiplier, and any scheduled change.
- No corporate action scheduled inside any live series' term.
- The vault's token account is not frozen and the mint is not paused.
- Every allowlisted `FeedConfig` has `source_kind == Pyth`. A `Mock` feed on
  mainnet means the operator writes the price the series settles against.
- `min_verification_signatures` is non-zero on every feed config.
- `pyth.rs` re-checked against the published SDK.

The permanent delegate is the strongest lever the issuer holds. Treat it
as a headline risk in the UI and the market manifest, not a footnote: it is the
one way `P` can be short at maturity through no fault of the contract.

The failure mode to avoid is the one this ecosystem produces constantly: an
appealing claim about something that is not actually true on-chain. Every
sentence in the UI about safety should survive somebody opening the mint
account on an explorer.
