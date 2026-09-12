# Audit brief

Everything an external reviewer needs to start, and an honest account of what
internal work has and has not established. `SECURITY.md` is the threat model and
the internal findings; this is the scope, the priority order, and the parts we
believe are weakest.

**Status: no external audit has been performed.** Every claim below about
correctness comes from internal review and from the test tiers listed at the
end. Both are stated so they can be discounted appropriately.

## What the protocol does, in one paragraph

Collateral — a tokenized equity, a Token-2022 mint — is locked in a vault and
split into two plain SPL claim tokens: `P`, which pays the stock up to a cap,
and `N`, which pays everything above it. At maturity an oracle price is read and
the vault is partitioned into two pools; holders redeem against their side.
The writer's whole compensation for capping their upside is the premium from
selling `N`, so an order book exists to make `N` quotable, with its hot path on
a MagicBlock ephemeral rollup and the money on Solana.

## Scope, in priority order

Priority is by what holds collateral and by how much of it is newly written.

### 1. `programs/series` — 2,467 lines — **highest**

The only program that holds collateral. Everything else is policy, listing or
trading around it.

Look hardest at:

- **The settlement partition.** `p_pool + n_pool == collateral_at_settlement`
  is invariant 3, and redemption pays pro-rata against those pools. §7 prices a
  shortfall proportionally rather than first-come, precisely so a permanent
  delegate drain cannot be front-run by whoever redeems first. That reasoning is
  the load-bearing part.
- **`scaledUiAmount` handling.** The strike is adjusted by the multiplier ratio
  at settlement (§6). `collateral.rs` reads the extension live. A rebase that
  the strike adjustment gets wrong is a silent mispricing of every position.
- **`sweep_dust`.** It takes the entire remaining balance once both supplies are
  zero. That is intended, and it means a holder who burns claim tokens without
  redeeming forfeits their collateral to the fee recipient.
- **Token-2022 transfer paths.** Every collateral movement goes through
  `spl_token_2022::onchain::invoke_transfer_checked`, which resolves transfer
  hook accounts. The mint's issuer can arm a hook after the series exists.

### 2. `programs/market` — 1,178 lines — **high**

`SECURITY.md` says it plainly: the internal review covered the series and oracle
lifecycle and **must not be read as an audit of `market`'s escrow ledger or its
ephemeral-rollup session controls.** It holds real deposits in three vaults.

Look hardest at:

- **The delegation lifecycle.** While `Book` is delegated it is owned by the
  delegation program, so `deposit` and `withdraw` fail their owner check — that
  is the entire mechanism keeping the rollup's ledger and the vaults from
  diverging. It is load-bearing and it is implicit.
- **`undelegate_book` as an availability risk.** Withdrawals are impossible
  until it lands. A session that cannot be exited strands deposits.
- **The matching engine's conservation.** Slot balances must sum to no more
  than the vaults hold, and nothing in the program enforces it — the property
  rests on `deposit` and `withdraw` being the only writers.
  `scripts/monitor.ts` checks it from outside. Note the quote vault is shared
  between a market's two books, so the check sums across both.

### 3. The three Pinocchio ports — 4,629 lines — **high, and newest**

`variants/{oracle-adapter,factory,market}-pinocchio`. These reimplement the
Anchor programs without Anchor. **`#[derive(Accounts)]` generates the ownership,
signer, writable, PDA and `has_one` checks; these generate nothing, so every one
is hand-written — and those checks are the security model.**

- `variants/ACCOUNT-CHECKS.md` maps every Anchor constraint to the line in the
  port that carries it, marks where a port is *stricter* than the original, and
  names the rows where no local check exists because a CPI callee rejects it
  instead. Start there; it is meant to be attacked, not trusted.
- The differential suites prove the ports match the originals on layouts,
  discriminators, error codes, engine state and CPI payloads. **They say nothing
  about whether the originals are correct.**
- `market-pinocchio` additionally hand-encodes MagicBlock's wire formats,
  because the SDK is written against `solana_account_info::AccountInfo` rather
  than Pinocchio's `AccountView`. `ScheduleIntentBundle`'s bincode variant index
  is **positional and unversioned**; `tests/delegation_wire.rs` compares every
  byte against the SDK's own serialisation so an upstream change breaks a test
  rather than silently invoking a different instruction.

### 4. `programs/factory` — 588 lines — **medium**

Holds nothing. Controls which series become canonical, which oracles may be
settled against, and which mints may be escrowed. A compromised admin cannot
touch existing collateral but can list a hostile series.

### 5. `programs/oracle-adapter` — 610 lines — **medium**

Finding 3 in `SECURITY.md` — an oracle admin swapping a Pyth feed for a mock —
is marked **fixed**: the mock backend was removed entirely, every read requires
the source account to be owned by the Pyth receiver, and the configured feed id
is immutable and checked against every decoded update.

What is worth reviewing is what remains of that surface. `set_source` can still
rotate the address, so an admin chooses which Pyth account of the configured
feed a series reads. The feed id check is what bounds that, and it is the thing
to attack.

## What we already know is wrong or unresolved

Stated up front so review time is not spent rediscovering it.

- **Upgrade authority is a single hot key on all four programs.**
  `scripts/preflight.ts` fails on this. Whoever holds it can replace any
  program, including the one holding collateral, and no on-chain check helps —
  the checker is what gets replaced. Unresolved; `docs/multisig-migration.md` is
  the runbook, and it needs a signature rather than more engineering.
- **The dividend case is unsolved.** The strike ratio is exact for a pure split;
  a cash dividend passed through by rebasing cannot be expressed. Creation
  refuses a *known scheduled* multiplier change, which is the conservative half
  of an answer. See `docs/decisions.md`.
- **The four delegation instructions have never been executed anywhere.**
  `delegate_book`, `commit_book`, `undelegate_book` and `process_undelegation`
  need a MagicBlock stack, which CI does not have. Their payloads are proven
  byte-identical to the SDK's; that is not the same as having run them.
- **The books are empty.** No liquidity, so nothing has exercised the matching
  engine under contention on chain.
- **`market`'s ledger has no *on-chain* conservation check.** Nothing in the
  program asserts that the vaults cover what the slots claim. `deposit` and
  `withdraw` move tokens and update the ledger in the same instruction, so they
  cannot diverge through the happy path — but that is an argument about the
  code, not a property the chain enforces. `scripts/monitor.ts` now watches it
  from outside, which detects a divergence rather than preventing one.

## What internal work has established

Not a substitute for review — the point is to say what is already covered so
effort goes elsewhere.

```
cargo test --workspace         99   pure logic, incl. the §12 invariants
oracle-adapter-pinocchio       45   differential vs the Anchor build
factory-pinocchio              24   differential, incl. the CPI payload
market-pinocchio               22   engine differential + MagicBlock wire
make e2e                       12   full lifecycle, real Pyth account layouts
make pinocchio-oracle           6   executing on a validator
make pinocchio-factory          6   executing on a validator
make pinocchio-market           8   executing on a validator
web pnpm test:tour             all  the walkthrough, end to end
scripts/monitor.ts             --self-test fires all twelve alarms
                                   and both webhook-delivery paths
```

All of it gates on CI except `make rollup`, which needs a MagicBlock stack.

A caution about the numbers above, learned the hard way in this repo:
`make pinocchio-oracle` reported success for weeks while running **zero** tests,
because the suite looked for the program at one address and the Makefile
deployed it at another. The conformance test meant to catch exactly that
compared a constant against a transcribed copy of itself. Green suites are
evidence, not proof, and this one has already been fooled once.

## Reference

| | |
| --- | --- |
| Threat model, internal findings, known limitations | `SECURITY.md` |
| Invariant matrix and where each is covered | `docs/implementation.md` |
| Design decisions and what was rejected | `docs/decisions.md` |
| Anchor constraint → Pinocchio check mapping | `variants/ACCOUNT-CHECKS.md` |
| Framework comparison and the ports' rationale | `variants/COMPARISON.md` |
| Live invariant monitor | `scripts/monitor.ts` |
| Pre-deployment gate | `scripts/preflight.ts` |
