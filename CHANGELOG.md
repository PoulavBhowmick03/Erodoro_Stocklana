# Changelog

## Unreleased

### Trading workspace

- Added a dedicated, shareable static market route:
  `/trade/markets?market=<address>&view=n`. Switching P/N updates the URL while
  the original `/app?series=<address>` links remain readable.
- Replaced the stacked trading controls with a responsive market workspace:
  order book, live depth, account activity and market information stay on the
  left while a persistent P/N limit-order ticket stays on the right.
- Added an always-visible live market-price chart above the order ladder. It
  records real best-bid/best-ask midpoint observations per market and leg,
  offers 1H/1D/1W/All ranges, and keeps an honest empty state until a quote
  exists.
- The complete market remains readable without a wallet. Signing is requested
  only when an order is submitted, with a clear disabled state beforehand.
- Kept the conventional asks / spread / bids ladder and made each price level
  prefill the matching side of the ticket.
- Folded deposits, claims and execution-session controls into **Market
  operations (powered by MagicBlock)** so custody administration no longer
  interrupts the normal trade path.
- Applied the same information hierarchy to both the compatible Manifest path
  and the built-in fallback CLOB, including uninitialized-market states and a
  one-column mobile layout.

Deploy cost for the four programs went from **8.9230 SOL to 3.5070 SOL** —
5.4160 saved, 60.7%. Three of the four are on Pinocchio; `series` is not.

| program | build | bytes | rent |
| --- | --- | ---: | ---: |
| oracle_adapter | Pinocchio | 25,960 | 0.1819 |
| factory | Pinocchio | 36,592 | 0.2559 |
| market | Pinocchio | 73,528 | 0.5130 |
| series | Anchor, `no-idl` | 367,104 | 2.5562 |

Two corrections to the figures this table carried before. `market` was recorded
at 80,600 bytes and had since grown to 81,440, so the pre-flag total was 3.8144
rather than the 3.8131 claimed. And the rent column was a few ten-thousandths
high per program: `(bytes + 173) * 6960` is exact, and it now checks against a
live account rather than against arithmetic — the deployed `market` holds
2.53703832 SOL at 364,344 bytes, which is that formula to the lamport.

### Deploy cost

- **Enabled the `no-idl` cargo feature** (0.766 SOL, no rewrite). Every program
  declared it; none switched it on. `anchor build --no-idl` only skips writing
  the IDL JSON — the `#[program]` macro still emits the on-chain IDL-account
  instructions, which were ~36 KB of dead weight in three programs. Nothing
  reads the on-chain IDL: there is no `Program.at()` or `fetchIdl` anywhere, and
  every client loads `web/lib/idl/*.json`.
- **Ported `factory` to Pinocchio** — 242,696 → 40,368 bytes, 1.4082 SOL.
- **Ported `market` to Pinocchio** — 363,848 → 80,600 bytes, 1.9714 SOL. All
  eleven instructions, including the four MagicBlock ones.
- **Adopted the existing Pinocchio `oracle-adapter`** into the deploy path,
  0.961 SOL.
- **Enabled `-Zlocation-detail=none` and `-Zfmt-debug=none`** — 0.2091 SOL, no
  source change. They drop panic location records and derived `Debug` bodies,
  neither of which anything here reaches: no program calls `msg!` and no program
  source formats a `{:?}`. Scoped through
  `CARGO_TARGET_SBPF_SOLANA_SOLANA_RUSTFLAGS`, not `RUSTFLAGS` — as the latter
  they also reach the host cargo `anchor build` runs, whose stable rustc refuses
  `-Z` and whose version probe strips `RUSTC_BOOTSTRAP`.
- **Moved `opt-level = "z"` from four per-package overrides onto
  `[profile.release]`** — 0.0983 SOL. An override applies to that crate alone,
  so every dependency was still building at 3, including `anchor-lang`,
  `anchor-spl` and `spl-token-2022`. `series` goes 381,224 -> 367,104 bytes.
  The cost, measured on the e2e suite: the heaviest `series` instruction goes
  from 98,261 to 122,080 CU against a 200,000 default, with the median at 4,492
  either way. The heaviest path is not in that number — the armed-hook lifecycle
  test was pending in both runs because its fixtures expire during the 56-second
  wait for the Pyth snapshots.
- **Added `make variants`.** The three Pinocchio deploy artifacts had no make
  target and were built by hand from `COMPARISON.md`, which now silently costs
  0.1018 SOL in missed flags.
- **Measured and rejected `no-log-ix-name`.** Saves 0.024 SOL and deletes the
  `Program log: Instruction: X` line from every invocation. Observability on a
  live deploy is worth more than a fortieth of a SOL — and at an eighth of what
  the two rustc flags return for nothing, it is not a close call.
- **Measured and blocked: `--arch v3`.** A further 0.2863 SOL by dropping
  relocation from the ELF entirely, for one build flag. SIMD-0178/0179/0189
  reads `inactive` on mainnet and devnet both, and a local validator will not
  load one either — `make pinocchio-oracle` against a v3 binary fails all 6 on
  `Program is not deployed`. Banked; re-read `solana feature status` before a
  mainnet deploy.

### Bugs found

- **`make pinocchio-oracle` was running zero tests.** The Makefile deployed the
  binary at `FMByTd4Jr…`; the suite looked for it at `AZnVLRAsvn…`, so
  `before()` skipped every run and mocha reported success. The conformance test
  meant to catch that compared the constant against a transcribed copy of
  itself. It now reads `oracle_adapter::ID`. This is the tier `COMPARISON.md`
  credits with catching a rent bug "and by nothing else".
- Repairing it surfaced three defects the skip had hidden: return data read from
  `getTransaction().meta` (not populated for a top-level instruction); a
  rotation test asserting `set_source` accepts a source on a *different* feed,
  which both builds correctly refuse; and a suite that only worked while the
  committed fixtures were stale, because `read_quote` rejects a publish time
  ahead of the clock.
- **`market`'s first complete Pinocchio build faulted on entry.** `Book` as a
  struct is 6,472 bytes against Solana's 4,096-byte stack frame limit;
  `process_instruction` came out at 20,672. Anchor never meets this because
  `Box<Account<Book>>` heaps the book. Fixed with `BookView`, a zero-copy view
  over the account bytes. Two things nearly let it through: `cargo build-sbf`
  reported the overflow on stderr and **exited 0 anyway**, and all 22 host tests
  were green throughout — only the validator tier could find it.
- **`Book::empty` started order ids at 0**; `initialize_book` starts them at 1.
  Found by reading the instruction, not by a test — a differential suite pins
  two implementations to each other and says nothing about a constant neither
  reaches.
- **`web/lib/idl/*.json` pointed at a different deployment** than
  `deployments/devnet.json` documents, under an upgrade authority this repo does
  not hold. Regenerated against the programs the repo controls, which is also
  what the CI `git diff --exit-code web/lib/idl/` gate expects.

### Test tiers

New: `make pinocchio-factory` (6) and `make pinocchio-market` (8), both
executing the ported programs on a validator rather than only in host tests.

```
cargo test --workspace         99
oracle-adapter-pinocchio       45
factory-pinocchio              24
market-pinocchio               22   (16 engine + 6 MagicBlock wire)
make e2e                       12
make pinocchio-oracle           6   (was 0, silently)
make pinocchio-factory          6
make pinocchio-market           8
web  pnpm test:tour            all
```

Two fixtures added so the oracle suite can run honestly: `at-600-alt` (same feed
id, different address — a valid `set_source` target) and `at-600-past` (behind
the clock, so a quote can be read at all).

### Frontend

Markets browsing moved toward Pendle's model.

- **The default guide is four trader stages, down from thirteen.** Choose one
  side, choose a contract, make that side's move, then open Portfolio. Test
  token creation, Registry administration and MagicBlock session operation no
  longer make an end user impersonate the seller, administrator, seller again
  and buyer in one walkthrough.
- **Guide stages now point at actions, not sections.** A high-contrast cue marks
  the visible trader controls, one contract row, the role-specific trade form,
  and the responsive Portfolio link. Choosing a trader and opening a contract
  advance the guide from the actual click instead of an unrelated Next button.
- **Rejecting a wallet prompt is cancellation, not a crash.** Expected wallet
  rejection events no longer trigger Next's console-error overlay and are shown
  inline as `Transaction cancelled in your wallet.`
- **Devnet setup now visibly starts with test-stock creation.** The page is
  labelled `Create test stock` and uses a horizontal Stock → Cash → List
  contract → Trade wizard. Only the active task renders; confirmed creation
  advances it, completed steps stay clickable, and asset balances are folded.
- **Mint forms are compact.** Stock extensions and buyer funding moved under
  Advanced disclosures, the active recipient is named in one line, and the
  third step is called `List contract` instead of exposing Registry jargon.
- **Contracts now links to that setup in the page body.** A prominent devnet
  card exposes `Create test stock` without requiring users to discover the
  collapsed Get started menu, and reflects a stock created in the current tab.
- **Disconnecting a wallet no longer empties the app.** Wallet connection is
  manual rather than automatic, every read-only surface stays rendered while
  disconnected, and only controls that need a signer remain disabled.
- **Hydration is now an explicit browser-test invariant.** The signed-out gate
  that produced different old/new AppChrome trees is gone, and the route suite
  fails if React reports a server/client markup mismatch.
- **Registry listing is one resumable administrator task.** Mint approval and
  contract creation keep their two-transaction boundary, but one action drives
  both and a failed second transaction resumes after the approval. The admin
  fixture appears only on Registry; seller and buyer fixtures appear only on
  trading and test-token screens.
- **MagicBlock custody and execution controls are advanced market operations.**
  They remain available and keep the `(powered by MagicBlock)` attribution,
  but start folded and are no longer steps in the default trading guide.

- **Contracts list is now a table** (`components/markets-table.tsx`), replacing
  the card stack. Active / Matured / Starred tabs, search across cap,
  collateral and address, sortable cap / maturity / listing order, a `new` badge
  driven by `SeriesRecord.index`, and favourites in `localStorage`.
- **The open contract lives in the URL** as `/app?series=<address>` — shareable
  links, a working back button, and a reload that stays put. Pendle gives each
  market its own path; this app is `output: "export"`, so a `[series]` segment
  would need `generateStaticParams` to enumerate addresses that do not exist at
  build time. A query parameter buys the same three things without a server.
- **Typed the on-chain accounts** (`lib/series-types.ts`). `SeriesView` was
  `config: any; settlement: any`, which makes every sort and filter one typo
  from a blank column.
- **Wired `OraclePanel` in.** It was dead code with a stale comment claiming
  `series` and `factory` were not deployed. It wanted a feed id while
  `SeriesConfig` stores the `FeedConfig` *address*; `lib/use-feed-id.ts` bridges
  the two.
- **Leg choice now says what each leg pays**, beside the `N book` / `P book`
  buttons rather than inside them.

- **A positions view** (`components/positions-panel.tsx`), behind a
  contracts / positions tab at `/app?view=positions`. Without it a holder had
  no way to answer "what do I own" short of reading their token accounts and
  matching mints by hand. It joins the registry against the wallet's balances
  rather than scanning, so it adds no round trips.

  The claimable figure is an *entitlement*, computed the way the program pays
  out — pro-rata against the pool the settlement recorded — not a balance. If
  the vault came up short the row says so, rather than quoting a number that
  will not arrive.

**Reverted during the change:** an initial version tabbed Trade away from
Lock/Unlock, the way Pendle separates Swap from Mint. That broke a documented
design decision — `SeriesDetail` orders the two by role because a seller must
mint before anything is useful and a buyer only needs the book — and the tour
asserts it (`the buyer sees the book before lock and unlock controls`). Role
ordering was restored rather than the test rewritten.

**Not copied from Pendle, deliberately:** implied-APY columns, because PT/YT
split a yield-bearing asset while P/N split a price outcome at a cap — an APY
column here would be misleading; and a liquidity column, while the books are
empty.

### Mainnet gates

- **`docs/multisig-migration.md`** — the runbook for the one blocker that needs
  a signature rather than a third party. Exact commands (including
  `--skip-new-upgrade-authority-signer-check`, which the transfer needs and
  which is easy to miss), and the two orderings that matter: least important
  program first, because a wrong vault address is unrecoverable; and prove the
  quorum can execute an upgrade *before* transferring `series`, because an
  authority nobody can exercise is worse than a hot key rather than better. Also
  names the keys this does **not** fix — the factory admin, the oracle admin,
  and the collateral issuer's permanent delegate.

- **`docs/audit-brief.md`** — the scope for an external review, in priority
  order by what holds collateral and how much is newly written: `series`, then
  `market` (whose escrow ledger the internal review explicitly did not cover),
  then the three Pinocchio ports (4,629 lines of hand-written account checks),
  then `factory` and `oracle-adapter`. It states what is already known to be
  wrong so review time is not spent rediscovering it, and lists what internal
  testing has established — with the caveat that this repo has already had a
  green suite that was running zero tests.

- **`variants/ACCOUNT-CHECKS.md` — every Anchor constraint, and where the port
  enforces it.** `#[derive(Accounts)]` generates the ownership, signer,
  writable, PDA and `has_one` checks; the ports generate nothing, so each is
  hand-written, and those checks are the security model. This maps each one to
  the line that carries it, marks where the port is *stricter* than Anchor, and
  names the rows where no local check exists because a CPI callee rejects it
  instead. It is not an audit — it is the mapping an auditor would otherwise
  have to reconstruct.
- **Writable checks the `market` port was missing.** Anchor marks `base_vault`,
  `quote_vault`, `trader_base` and `trader_quote` `mut` on deposit and
  withdraw, and the three vaults `init` on `initialize_market`; the port checked
  none of them. Not exploitable — the token and ATA CPIs reject a read-only
  account anyway — but the caller saw an SPL error where the Anchor build
  returns its own. Found by writing the mapping above, which is what it is for.

- **`scripts/monitor.ts` — the §12 conservation invariants, checked against a
  live cluster.** `docs/implementation.md` lists them and the suites cover them
  on the host and in e2e; neither says anything about the chain you actually
  deployed to. This reads every canonical series and asserts the same
  properties on real account state — supplies matched outside settlement, the
  vault covering what P can claim, the pools summing to the collateral
  escrowed, redemption never paying out more than was escrowed, and the vault
  still holding what it has yet to pay. It exits non-zero on a breach, so the
  exit code is the page.

  It also checks the order book's ledger: the vaults must cover what the slots
  claim traders are owed, per leg for base and summed across both books for
  quote, which is shared. `>=` not `==` — a surplus harms nobody and anyone can
  transfer tokens in; a deficit is what costs a withdrawer their money. A
  delegated book is a warning rather than a breach, because its L1 copy is as of
  the last commit and comparing that to a vault says nothing.

  `--webhook <url>` (or `MONITOR_WEBHOOK`) posts breaches and warnings as JSON
  to anything that accepts one — Slack, Discord, PagerDuty's events API. The
  exit code is still the real signal, but an exit code nobody watches is a log
  file. A delivery failure is reported and exits `3`, distinct from a breach's
  `1`: a monitor that silently could not reach its webhook reads as "all clear",
  which is the worst failure this tool has. Both paths are self-tested.

  `--snapshot <file>` adds authority-drift detection: every program's upgrade
  authority, every series' admin and status, and every feed's admin, source and
  signature floor. First run writes a baseline, every run after reports what
  moved. The conservation checks catch a vault that is already short; this
  catches the step before, an admin key being used at all — which matters
  because moving the *upgrade* authority to a multisig leaves the factory
  admin, the oracle admin and the series admin exactly where they were.

  It writes nothing and signs nothing: a monitor that can act is a monitor that
  can be turned into an attack.

  The checks are a pure function with a `--self-test` that fires every alarm,
  gated in CI. A monitor nobody has watched fail is indistinguishable from one
  that cannot — which is precisely how `make pinocchio-oracle` spent weeks
  reporting success while running nothing.

- **`scripts/preflight.ts` now fails on a plain-wallet upgrade authority.**
  Every program here can be replaced by whoever holds that authority, and
  `series` holds collateral — so a single hot key means the protocol is one key
  compromise away from being replaced with something that drains the vaults, and
  no on-chain check helps because the checker is what gets replaced. It passes on
  an authority owned by SPL Governance or Squads, or on a program deployed
  `--final`; an authority owned by an unrecognised program is a warning, because
  it may be a multisig this script does not know and a human has to say so. All
  four devnet deployments currently fail it, which is correct for devnet and a
  blocker for mainnet.

### Resilience

- **Error boundaries.** There were none, so an unhandled render error took the
  route down to a blank page. `app/error.tsx` catches what the data hooks do
  not, says plainly that funds are unaffected because this is the interface
  failing rather than the chain, and offers a retry that re-runs the fetches.
  `app/global-error.tsx` covers failures in the root layout, where the first
  boundary cannot reach — it supplies its own `<html>`/`<body>` and inline
  styles because Next replaces the layout when it fires, so `globals.css` does
  not resolve.
- **A production build that silently falls back to the public devnet endpoint
  now says so.** `clusterApiUrl("devnet")` is fine for a demo and cannot serve
  an audience: it rate-limits, and the first thing a user sees when it does is a
  page that looks broken. The banner only appears in a production build with no
  `NEXT_PUBLIC_RPC_URL`.

### Scaling
- **Listing series is now `1 + ceil(2N / 100)` RPC requests, not `1 + 2N`.**
  `useSeries` fetched every config and settlement one account at a time: three
  requests for the three series on devnet, two hundred for a hundred series.
  Public endpoints answer that with 429, so the page would have shown an error
  to a user whose only mistake was arriving once the protocol was popular.
  `lib/batch.ts` batches through `getMultipleAccounts`, in sequential chunks
  rather than a concurrent burst, which is the shape endpoints rate-limit.
- **Transient RPC failures now retry** with exponential backoff and jitter, and
  only for the errors worth retrying — 429, 5xx, timeouts. A rejected
  transaction is not retried, because it will be rejected again.
- **A guard on the decode names.** `Program`'s constructor normalises IDL
  account names to camelCase, so `program.coder.accounts.decode` answers to
  `seriesConfig` while the IDL spells it `SeriesConfig` — and a
  `BorshAccountsCoder` built from that same IDL answers to the PascalCase form
  instead. Passing the wrong one throws on every decode, and since a decode
  failure is deliberately tolerated (one bad account must not blank the list),
  the symptom is an empty markets table rather than an error.
  `scripts/check-accounts.mjs`, which CI runs, now asserts both resolve.

### CI

- **The validator tiers are back in CI.** `make pinocchio-oracle`,
  `pinocchio-factory`, `pinocchio-market` and `e2e` — 32 tests that actually
  execute the programs — gated nothing before. They had been pulled for three
  reasons; two are now fixed rather than tolerated. Fixture staleness: the job
  regenerates the Pyth fixtures first, so the tiers fail on the diff rather than
  on the calendar. Port collisions: each tier has its own RPC port and ledger.
  The third, `make rollup` needing a MagicBlock stack, is unsolved and stays
  local — so the four delegation instructions in `market` remain the part of
  this repo nothing executes automatically.
- **`make e2e` exited non-zero even when all 12 tests passed.** `anchor test`
  streams a log file per program in `[programs.localnet]` and reads them back
  afterwards; two of the five never emit anything, so the read fails *after*
  mocha has reported success. The target now takes its outcome from mocha, and
  treats a missing summary as failure so a run that crashed before reporting
  cannot pass by printing no `failing` line.
- The two new variant crates are now gated. CI ran the oracle variant's
  differential suite but not `factory-pinocchio` or `market-pinocchio`, so 46
  tests — including the MagicBlock wire-format equivalence check that is the
  entire mitigation for a positional, unversioned bincode enum index — were not
  gating anything.

### Housekeeping

- Deleted `components/series-list.tsx`, replaced by the markets table.
- Listed the two new variant workspaces in the root `Cargo.toml` exclude.
- `variants/COMPARISON.md` corrected: it claimed the two oracle builds shared a
  program id. They did not.
