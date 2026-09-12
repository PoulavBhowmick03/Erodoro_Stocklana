# erodoro

**Tokenized-equity upside markets on Solana, powered by MagicBlock.**

Lock an eligible tokenized equity, choose a strike and expiry, and offer the
upside to someone else for USDC.

New here? [`docs/idea.md`](docs/idea.md) explains it in plain language.

## What it does

Lock 1 demo equity worth $400. Pick a $500 strike and an expiry. You get back two
claims — `P` and `N` — and offer `N` for USDC on a Manifest price-time order book.
At expiry the locked collateral is split between the two sides against an oracle price:

| Collateral at expiry | `P` receives | `N` receives |
| --- | --- | --- |
| $250 | all of it — $250 | nothing |
| $400 | all of it — $400 | nothing |
| $600 | $500 worth | $100 worth |
| $1000 | $500 worth | $500 worth |

`P` is a capped equity claim. `N` is the upside claim above the strike and can
expire worthless. In traditional terms the `P` holder has written a covered
call and the `N` holder owns it.

> [!IMPORTANT]
> **This is not downside protection.** Below the entry price the `P` holder takes
> the full fall in the collateral. The USDC received from selling `N` is the only
> offset. Any interface that implies otherwise is
> wrong.

## Why it is not trivial

The collateral is a Token-2022 mint whose issuer holds four live levers over
anything sitting in a vault. Three of them need code:

- **`scaledUiAmount`** — a stock split rebases every balance. Settle a
  post-split price against a pre-split strike and `N` is wiped out by an event
  in which nobody lost money. The strike is adjusted by the same ratio [§6].
- **`permanentDelegate`** — the issuer can move collateral out of a *settled*
  vault. No check prevents it, so redemption prices the shortfall
  proportionally instead of paying first-come-first-served [§7].
- **`transferHook`** — dormant today, armable without redeploying the mint.
  Every collateral movement resolves hook accounts from day one [§9].

Plus `pausableConfig` and a freeze authority, which need no code but do need
saying out loud. See [`SECURITY.md`](SECURITY.md).

## Layout

```
common/                      math, error table, cross-program types
programs/oracle-adapter/     feed identity, freshness, Pyth decoding
programs/series/             the vault and settlement engine
programs/factory/            policy bounds, allowlists, canonical registry
programs/test-transfer-hook/ test hook that counts its own executions
programs/market/             retained custom-market prototype and lifecycle tooling
Manifest fork               canonical P/N price-time CLOB delegated to MagicBlock
ephemeral-spl-token          projects trader and market token balances into the session
web/                         landing page and app (static export)
```

## The registry

`factory` is the registry. It decides four things:

- **Which prices count.** A listed series settles against a feed the admin
  approved, and nothing else.
- **Which tokens count.** Same for collateral. An unapproved mint cannot back a
  listed series.
- **Bounds on the terms.** At least an hour to maturity, an oracle age of at
  most a week, a fee of at most 10%. These are policy, not arithmetic: `series`
  independently rejects anything incoherent, and these narrow the coherent set
  to the sensible one.
- **The list.** Front ends enumerate `SeriesRecord`, never the `series`
  program's accounts at large.

The distinction nobody guesses is that **creating a series is permissionless;
being listed is not**. A series is a PDA of the `series` program and anyone can
create one directly. It will work. It just has no registry record, so nothing
reading the registry surfaces it. The factory is not the only door, it is the
thing that says which series are canonical.

What it deliberately cannot do is as load-bearing as what it can. It holds no
collateral and has no authority over a series once that series exists: it cannot
pause one, settle one, or move a token out of a vault. An admin key decides what
may be listed and has no further reach, which is what keeps the registry from
being a place worth attacking.

## Tests

The repository has native, local-validator, browser/static-export, public-devnet,
Manifest and MagicBlock lifecycle checks. **There is no mock-oracle program.** The devnet oracle
suite is currently skipped because its deployed binary predates the current
IDL. Local settlement tests load real `PriceUpdateV2` account-layout
snapshots under the Pyth receiver owner, then alter price and time fields for
deterministic scenarios. They prove decoding and contract constraints, not
Pyth signature verification.

| Tier | Command | What only it can reach |
| --- | --- | --- |
| Native unit + property | `make test` | Payoff and matching math and program guards, without a validator |
| End-to-end, local validator | `make e2e` | Account constraints, factory→series CPI, Token-2022 collateral, transfer hooks and Pyth-layout settlement |
| Web unit + browser | `pnpm --dir web test:ux` | Static export, hydration, routes, disconnected UX, strategy gating and safety copy |
| Public devnet invariants | `pnpm monitor -- --cluster devnet` | Canonical series and vault solvency against deployed accounts |
| Manifest market inspection | `pnpm manifest:bootstrap` | Canonical P/N book existence and public MagicBlock delegation state |
| Manifest + ephemeral SPL | `pnpm rollup:manifest-fork` | Matching, cancellation, commit, undelegation, L1 claims and conservation on the local two-validator stack |

The two scenarios the design exists for are both verified on a validator
against a real Token-2022 mint: a 2-for-1 split mid-series leaves both pools
bit-identical to the unsplit case instead of wiping out `N`, and a
permanent-delegate drain of a settled vault pays the first and last redeemer on
each side within 2 raw units of each other.

## Security

Internal review has fixed series-settlement denial of service, address
squatting, mock-oracle substitution, zero-signature feeds, incoherent
settlement timing, and full-domain multiplication. The separate market
prototype still has unresolved findings. Details and the threat model are in
[`SECURITY.md`](SECURITY.md).

The canonical Manifest/ephemeral-SPL integration has an internal engineering review
in [`docs/ephemeral-spl-token-audit.md`](docs/ephemeral-spl-token-audit.md). The
public commit-and-undelegate path remains blocked until the canonical ephemeral-SPL
deployment accepts the optional MagicBlock fee-vault account.

**There is no external audit yet. Nothing in the devnet demo has real value.**

Before any deployment, run the preflight check — it reads the live mint's five
extensions and every feed config and exits non-zero on anything unsafe:

```sh
make preflight MINT=XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB
```

## Building

Requires platform-tools **v1.52 or newer**. The version bundled with
solana-cli 3.0.13 ships rustc 1.84, which cannot parse several crates in the
dependency graph that now require edition 2024.

The frontend builds from the repo root — `pnpm build` delegates into `web/`
and emits a static export to `web/out`. `wrangler.jsonc` deploys that directly
as an assets-only Worker. See [`web/README.md`](web/README.md).

```sh
pnpm build     # the landing page and app
make test      # native tests
make build     # SBF artifacts -> target/deploy/*.so
make idl       # IDLs -> target/idl/*.json
make e2e       # end-to-end lifecycle on a local validator, against real Pyth
make devnet    # oracle adapter against live Pyth on devnet
make devnet-market  # the order book against the devnet deployment
```

## Deployed

Devnet — see [`deployments/devnet.json`](deployments/devnet.json):

| Program | Address |
| --- | --- |
| `oracle_adapter` | `FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz` |
| `series` | `AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9` |
| `factory` | `CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ` |
| `market` | `FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC` — prototype predating current local fixes |

All four are live, so the full lifecycle now runs on devnet rather than only on
localnet. `test-transfer-hook` is not deployed and is not meant to be; it exists
to be armed inside the test suites. `mock_oracle` was closed to reclaim rent
before the others went up, and a closed program address cannot be reused.

The app now has a fail-closed Mainnet build path, but there is no Mainnet
deployment. The RPC genesis hash is verified before wallet state mounts, and
the public Devnet keys are enabled only by the exact Devnet build target. They
remain committed fixtures, so treat them as public.

## Front end configuration

The app is a static export. Cloudflare serves those assets directly and runs a
small Worker only for `/rpc`. The deployed devnet build calls that same-origin
route; the Worker reads `HELIUS_API_KEY` from a Cloudflare secret and forwards
an allowlisted set of Solana JSON-RPC methods. The key is not compiled into the
browser bundle. Local devnet development starts on Solana's public endpoint and
fails over to the same proxy on rate limits or temporary transport failures;
Mainnet uses the explicit `NEXT_PUBLIC_MAINNET_RPC_URL`. See
[`web/.env.example`](web/.env.example).

Devnet may default to the public endpoint. Mainnet requires explicit Solana and
MagicBlock endpoints, a validator identity, and production program addresses;
its prebuild fails when any are absent. See
[`web/.env.mainnet.example`](web/.env.mainnet.example).

Other production hosting targets must provide their own server-side RPC proxy
or use a provider credential that is safe to expose and origin-restricted.

## Status

The series lifecycle and environment-neutral application flow are implemented
and tested. Mainnet configuration deliberately contains no invented deployment
addresses and remains unavailable until its release gates are complete. Those
include the ephemeral-SPL exit deployment, permissionless maturity exit, an
external audit, multisig authorities, issuer and oracle approval, a live
deployment, and a counterparty willing to buy `N`.

## Docs

- [`docs/idea.md`](docs/idea.md) — the product in plain language
- [`docs/magicblock.md`](docs/magicblock.md) — what runs on Solana, what runs in a rollup, and why
- [`docs/implementation.md`](docs/implementation.md) — what was built, where the design was wrong, what the tests prove
- [`docs/decisions.md`](docs/decisions.md) — the open design questions and where each landed
- [`docs/ux-remediation-plan.md`](docs/ux-remediation-plan.md) — the UX, terminology, routing, safety, and devnet verification plan
- [`docs/known-limitations.md`](docs/known-limitations.md) — the current deployment, trading, market-data, RPC, and operations boundaries
- [`docs/mainnet-promotion.md`](docs/mainnet-promotion.md) — the shared-code, issuer-adapter, network-isolation, and release workflow
- [`SECURITY.md`](SECURITY.md) — threat model and review findings

Bracketed § numbers throughout refer to sections of the internal design note.

## License

Apache-2.0
