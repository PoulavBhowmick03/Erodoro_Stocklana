# The rollup split: what runs where

The `market` program is the only part of erodoro that touches an ephemeral
rollup, and it exists for one reason.

## Why a rollup at all

The P holder's entire compensation for capping their upside is the premium
from selling N. That premium only exists if somebody can profitably quote N —
and today nobody can.

An options market maker has to reprice as spot moves. On a thin, short-dated
leg that means hundreds or thousands of quote updates an hour against very
little volume. If each update costs a fee and lands 400ms later, the spread the
maker must charge to break even is wider than the premium is worth, so they
don't quote, so there is no premium, so the product has no value proposition.

Sub-50ms gasless updates change that arithmetic. That is the whole argument.
Nothing else in this repo needs a rollup, and nothing else uses one.

## What stays on Solana

Everything that holds value or decides it.

| | Why |
| --- | --- |
| Collateral vault, P and N mints | Owned by Token-2022 and SPL Token, so they **cannot** be delegated even in principle |
| Pyth price account | Owned by the Pyth receiver — same |
| `SeriesConfig`, `Settlement` | *Could* be delegated; must not be. Settlement freezes pools against the vault's real balance, and the issuer can drain that vault on L1 at any moment. A settlement record in a rollup could compute the shortfall haircut against a balance that no longer exists. |
| `market` vaults, `deposit`, `withdraw` | Real token accounts and real transfers |

All of it is touched a handful of times across a three-month series. Latency
buys nothing.

## What goes in the rollup

Exactly one account: the `Book` for a leg, holding **orders and per-trader
balances together**.

That co-location is the load-bearing decision. Per-trader balance PDAs would be
more idiomatic on L1 and much worse here — every match would need both sides'
accounts delegated to the same validator, and a maker who undelegated
mid-session would silently become unfillable. One hot account means a match is
a single mutation and a session is a single delegation.

`place_order`, `cancel_order` and `fill_order` take no token accounts at all.
That is what makes them rollup-safe: they move entries in a ledger, and no
token moves until somebody withdraws on L1.

## The lifecycle

```
L1   deposit          real tokens into the vaults, credit the ledger
       ↓
L1   delegate_book    Book's owner becomes the delegation program
       ↓
ER   place / cancel / fill      ← the only high-frequency part
       ↕ commit_book            push the ledger to L1, session continues
       ↑ undelegate_book        commit and hand the Book back
       ↓
L1   withdraw         debit the ledger, real tokens out
```

## The concurrency property you get for free

While the `Book` is delegated it is owned by the delegation program. `deposit`
and `withdraw` take it as `Account<'info, Book>`, so Anchor's owner check
rejects them automatically — no code, no flag, no reviewer having to remember.

A balance therefore cannot be withdrawn on L1 while a rollup is still mutating
it. This removes one source of ledger/vault divergence: concurrent mutation on
the two execution layers. It does **not** prove that matching arithmetic
preserves the vault totals; that invariant must be audited independently.

`tests/rollup-session.ts` asserts it directly: with a session open, both
`deposit` and `withdraw` are rejected on L1, and they work again the moment the
book is undelegated.

## The one rule the model does not enforce

Nothing in the delegation machinery stops a book from trading past its series'
maturity. At settlement, P and N stop being instruments and become claims on a
frozen pool — a book still quoting them would be pricing something already
decided, and redemption reads `Settlement` on L1 while balances sit in a rollup
L1 cannot see.

So the program enforces it: `place_order` and `fill_order` reject once
`maturity_ts` has passed. **Undelegate before maturity.** Cancelling and
withdrawing stay open afterwards so nobody is trapped.

## Why `market` is on a different Anchor version

`market` builds against anchor-lang 1.x; the other four programs are on 0.31.1.

The ephemeral-rollups SDK requires `solana-account-info` 3.x, which in practice
means anchor-lang 1.x. Dragging the audited vault and settlement programs onto
a new major Anchor version to satisfy a dependency of the trading layer would
be a far larger and riskier change than it earns.

It is safe because `market` is standalone: it depends on no other crate in this
workspace and exchanges no Rust types with them — only account data, through
the chain. Cargo keeps both versions side by side without complaint.

## Running a session

The rollup half runs against a local MagicBlock stack — a base validator on
8899 and an ephemeral validator on 7799 — with `market` preloaded:

```sh
npm install -g @magicblock-labs/ephemeral-validator

anchor build
mb-stack --reset --upgradeable-program \
  target/deploy/market-keypair.json target/deploy/market.so "$(solana address)"

pnpm rollup
```

`tests/rollup-session.ts` walks the whole lifecycle above: it mints real tokens,
deposits on L1, delegates, trades in the rollup, commits mid-session,
undelegates, and withdraws the premium the maker earned inside the rollup back
into a real wallet on L1. It also checks the boundary in both directions —
that L1 refuses writes while a session is open, and that L1's copy of the book
is genuinely untouched until someone commits.

Measured on the local stack, consistent across runs:

| | |
|---|---|
| place an order in the rollup | 7–17 ms |
| fill an order in the rollup | 6–12 ms |
| `commit_book` accepted | 5–20 ms |
| committed state visible on L1 | ~510 ms |
| `undelegate_book` round trip | ~515 ms |

The gap between the last two rows and the first three is the whole argument for
the split. Quoting is free and instant; touching the base layer costs half a
second. A market maker repricing a hundred times a minute can afford exactly one
of those.

One client-side wrinkle worth knowing before you write against this: web3.js's
`sendAndConfirm` waits on a signature notification that the rollup does not
reliably deliver, so it can throw `TransactionExpiredTimeoutError` on a
transaction that already succeeded — and mixing raw sends with Anchor's `.rpc()`
makes the next `.rpc()` stall for the full 30-second timeout. Send rollup
transactions by one path and poll `getSignatureStatuses`; `sendToEr` in the test
is the pattern.

## Status

- The L1 half is implemented and deployed to devnet as a prototype. Deployment
  is not evidence that its accounting or initialization model is production-ready.
- The rollup session itself is not yet exercised end-to-end. Delegating needs a
  MagicBlock validator; the instructions are in place and the account layout is
  built for it, but no session has run.

That ordering is deliberate. A fast exchange for an instrument nobody has
traded is the wrong thing to build first — the escrow arithmetic and the
L1/rollup boundary have to be right before latency matters at all.
