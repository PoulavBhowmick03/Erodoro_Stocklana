# UX remediation plan

Status: implementation in progress; action-first trading and market-discovery pass added; final verification pending
Last reviewed: 2026-08-22

## Implementation record — 2026-08-22

Completed in the application:

- Payoff boundary copy and the permanent zero-signature oracle warning.
- Devnet-specific landing copy, worked example, visible risk section, P/N definitions,
  buyer education and decision-focused FAQ.
- Canonical `/portfolio` and `/admin/registry` routes with compatibility redirects.
- Markets, Portfolio, Demo setup and administrator information architecture.
- Strategy-led N trading with P behind Advanced trading.
- Automatic Manifest seat, balance projection and deposit preparation when an order is
  submitted; no trader-facing book/custody/preparation actions remain.
- Automatic P and N Manifest market creation and MagicBlock activation during listing.
- Action-first terminal hierarchy, price chart, order summary, break-even metrics,
  permissionless settlement, redemption actions and transaction lifecycle feedback.
- A non-blocking first-visit guide offer and four contextual walkthrough steps.
- Static-export, hydration, route, safety, terminology, wallet-rejection and MagicBlock
  policy regression coverage.

Verification completed:

- `pnpm --dir web test:unit` — 19 passing.
- `pnpm --dir web build` — all eight application routes statically generated.
- `pnpm --dir web test:tour` — all UX/hydration checks passing against the built export.
- `pnpm monitor -- --cluster devnet` — 24 invariant checks, zero breaches.
- `pnpm manifest:bootstrap` (inspection mode) — all eight canonical P and N books are live
  on the public MagicBlock validator.

Remaining external verification boundary:

- The public MagicBlock canonical ephemeral-SPL deployment does not yet contain the
  optional fee-vault account accepted by the pending upstream change. Public placement,
  matching and cancellation are testable; public commit-and-undelegate cannot pass until
  that deployment is upgraded. The separate-custody architecture decision remains open
  pending maintainer feedback and is intentionally not changed by this UX implementation.

This document turns the current UX review into an implementation and verification
checklist. It covers the landing page, market directory, market terminal, Portfolio,
demo setup, administrator registry, onboarding, terminology, safety disclosures, and
transaction feedback.

## Original confirmed findings

The code at the time of the review confirmed these issues. The implementation record
above is the source of truth for what has since been remediated:

- The payoff calculator describes the distance below the strike as a fall from the
  entry price. At a settlement price of `$420`, it incorrectly calls the `$80`
  distance to the `$500` strike a fall even though the position is `$20` above its
  `$400` entry price.
- A zero-signature oracle threshold is disclosed only inside nested market details.
- `/app?view=positions` retains the Contracts metadata, heading, and description.
- The landing hero still says `Launch App` despite the product being devnet-only and
  unaudited.
- The landing page still contains the unrelated Hedge/perpetuals card.
- User-facing copy mixes contract, market, series, cap, strike, maturity, expiry,
  cash, and USDC.

The redemption recommendation has also been checked against the program. Redeeming P
or N burns the claim and transfers a proportional amount of the locked collateral
token to the holder. It does not redeem into USDC.

## Product decisions and constraints

These decisions resolve conflicts between older review recommendations and the most
recent product direction:

1. The public landing header exposes Product, How it works, Risks, Docs, GitHub,
   Request access, and **Try devnet** while retaining the `erodoro` wordmark.
2. The hero contains **Try on devnet**, **Request early access**, and the contextual
   **See how settlement works** link.
3. The removed red “Not downside protection” banner will not return. The same material
   risk will be presented in a neutral, permanent risk section and at the relevant
   trade decision point.
4. Normal trading is strategy-led and N-focused. P trading remains available behind
   an **Advanced trading** control.
5. `Market` is the user-facing object. `Series` is reserved for technical identifiers
   and administrator details.
6. Existing shared URLs remain compatible while canonical routes move to `/portfolio`
   and `/admin/registry`.
7. Market data remains visible without a wallet. A signer is required only when the
   user submits a transaction.
8. MagicBlock remains the only order-mutation route. The UI must never silently fall
   back to Solana for placing, filling, or cancelling orders.
9. The live trading workspace appears before payoff, oracle, risk, and protocol
   education. Those explanations remain available in tabs below the execution surface.
10. No Three.js or WebGL effect is part of the application interface.

## Global terminology

| Avoid | Use |
| --- | --- |
| Contract | Market, or series in technical/admin details |
| Cap | Strike |
| Stock | Tokenized equity or collateral |
| Cash | USDC |
| Maturity date | Expiry date |
| Capped share | P · Capped equity claim |
| Upside token | N · Upside claim |
| Launch App | Try on devnet |
| Lock | Lock and mint P + N |
| Unlock | Merge P + N and unlock |
| Open N book | Initialize N market |
| Claimable: not settled yet | Not yet claimable |
| Registry | Admin registry |

Shared labels, lifecycle statuses, and descriptions should live in common copy/status
helpers. Component-local variants should not be introduced unless the context changes
the meaning.

## Phase 1: correctness and safety

### 1.1 Fix payoff explanations

- Branch the explanation around both the `$400` entry price and `$500` strike.
- Below entry: state the loss from entry, P value, and that N expires worthless.
- Above entry but below strike: state the gain from entry, P value, and that N expires
  worthless.
- Above strike: state that P is capped at the strike and N receives the remainder.
- Rename calculator labels to **P · Capped equity claim** and **N · Upside claim**.

Required cases:

| Settlement | Required meaning |
| ---: | --- |
| `$250` | `$150` below entry; P is `$250`; N is zero |
| `$400` | Level with entry; P is `$400`; N is zero |
| `$420` | `$20` above entry and below strike; P is `$420`; N is zero |
| `$500` | At strike; P is `$500`; N is zero |
| `$600` | P is `$500`; N receives `$100` |

Acceptance criteria:

- No copy describes strike distance as investment gain or loss.
- Boundary cases are unit-tested independently of React rendering.
- The calculator, payoff table, and market preview use the same terminology.

### 1.2 Surface unsafe oracle configuration

- Lift oracle readiness/configuration state so the terminal can render a safety banner
  without making a second oracle request.
- If `minVerificationSignatures === 0`, show this above the trading workspace:

  > **Unsafe devnet oracle configuration:** this market currently accepts a price
  > with no minimum signature threshold. Do not use assets with real value.

- Keep full price, source, age, signature threshold, and config addresses in expanded
  diagnostics.
- Use an accessible alert role and do not allow the warning to be hidden by default.

Acceptance criteria:

- Every affected market shows the warning before the order form.
- Safe configurations do not show the warning.
- Stale and unconfigured oracle states remain distinct from a zero-signature warning.

### 1.3 Correct product-state language

- Change the hero CTA from **Launch App** to **Try on devnet**.
- Replace the unrelated Hedge card with the buyer-focused content in Phase 2.
- Keep “not on mainnet” and “unaudited” explicit wherever users can enter the app.

## Phase 2: landing page

### 2.1 Hero

Use:

> # Set your strike. Sell the upside.
>
> Lock an eligible tokenized equity, choose a strike and expiry, and sell the value
> above that strike. When your N order fills, you receive USDC upfront and keep the
> capped position below it.

Actions:

- **Try on devnet** → `/app`
- **Request early access** → current access intake
- **See how settlement works** → payoff section

On desktop, use the open right side for a compact worked example:

| Example | Value |
| --- | ---: |
| Tokenized equity at entry | `$400` |
| Strike | `$500` |
| N sold for | `20 USDC` |
| Seller keeps | `P + 20 USDC` |

No Three.js/WebGL surface or custom cursor is used. The worked example carries the
visual explanation without consuming a browser graphics context.

### 2.2 Visible risk statement

Add a permanent, neutrally styled risk block immediately after the hero:

> **You still bear the downside.** If the collateral falls, P falls with it. The
> USDC received for N is the only offset.

Issuer permanent-delegate risk must also appear in a visible Risks section rather
than only inside the FAQ.

### 2.3 How it works

Use three cards:

1. **Lock** — Deposit eligible collateral and choose a strike and expiry. Mint equal
   amounts of P and N.
2. **Sell N** — Offer N for USDC through the order book. USDC is received only when
   an order fills.
3. **Settle** — After expiry, settlement uses the market's predefined Pyth feed and
   settlement window. The caller cannot substitute another price.

### 2.4 Explain P and N before the calculator

Show permanently:

- **P · Capped equity claim:** receives the collateral value up to the strike.
- **N · Upside claim:** receives the collateral value above the strike.

Display the formulas:

```text
P = min(S, K)
N = max(S - K, 0)
```

where `S` is the settlement price and `K` is the strike.

Change the example caption to:

> One tokenized equity worth `$400` when the position is created. Strike: `$500`.
> Values exclude any USDC received from selling N.

### 2.5 For upside buyers

Replace “The other side” and its Hedge card with four cards:

- **Receives:** value above the strike; N expires worthless below it.
- **Maximum loss:** the purchase price, with no margin call, liquidation, or further
  amount owed.
- **Liquidity risk:** early exit requires another trader and may face wide spreads or
  no available buyer.
- **Fixed expiry:** N settles once on a specified date and has no funding rate.

### 2.6 FAQ

- Move the basic P/N definition above the calculator.
- Move permanent-delegate seizure risk into the visible Risks section.
- Keep the remaining decision-focused questions.
- Add:

  > **What do I receive at redemption?** P and N redeem for proportional amounts of
  > the locked tokenized-equity collateral—not USDC. The oracle price determines how
  > the collateral is divided between the two pools.

## Phase 3: routes and application navigation

Canonical routes:

| Route | Purpose |
| --- | --- |
| `/app` | Markets |
| `/portfolio` | Portfolio |
| `/mint` | Demo setup |
| `/admin/registry` | Administrator-only registry and listing |
| `/trade/markets?market=…&view=n` | Shareable market terminal |

Compatibility:

- Redirect `/app?view=positions` to `/portfolio`.
- Redirect `/create` to `/admin/registry`.
- Preserve market address and selected claim in shareable terminal URLs.

Application navigation:

- Markets
- Portfolio
- Demo setup on devnet
- Wallet

Additional behavior:

- Show Admin registry only when the active signer matches the factory administrator.
- Keep the route directly reachable so an administrator can connect there.
- Move Learn into contextual documentation/help.
- Replace the permanent test-trader panel with a compact devnet bar:

  > **Demo account:** Seller · 0.65 SOL  [Switch]

- Do not hide markets, portfolio empty states, or terminal data while disconnected.

## Phase 4: Markets and Portfolio

### 4.1 Markets

Header:

> # Markets
>
> Choose a tokenized equity, strike and expiry. Collateral owners can create P and N
> and sell their upside; buyers can purchase the upside without margin.

Intent controls:

- **Sell upside:** Lock tokenized equity, keep P, and offer N for USDC.
- **Buy upside:** Buy N for exposure above the strike. Maximum loss is the purchase
  price.

Table:

| Strike | Underlying | Expiry | Time left | Status | Series |
| ---: | --- | --- | ---: | --- | ---: |

Implementation details:

- Resolve Token-2022 metadata once per mint and cache it.
- Show symbol/name first and a shortened mint below it.
- Use lifecycle-aware statuses: Open, Expired, Awaiting settlement, Redeemable.
- Replace “Listed #1” with “Series #1”.
- Remove the unexplained `new` badge or give it an accessible explanation.
- Search by strike, symbol, name, series address, and mint.
- Distinguish filtered-empty, registry-empty, network-error, and undeployed states.
- Show the large demo-asset setup card only when a demo user has no assets; otherwise
  reduce it to setup progress.

### 4.2 Portfolio

Create a dedicated `/portfolio` route with:

- Browser title: `Portfolio · erodoro`
- H1: `Portfolio`
- Description: `Your P and N positions, upcoming expiries and available redemptions.`

Table:

| Underlying | Strike | P balance | N balance | Expiry | Status | Action |
| --- | ---: | ---: | ---: | --- | --- | --- |

Statuses:

- Open
- Expired · settlement pending
- Redeemable
- Redeemed
- Shortfall haircut

Contextual actions:

- View market
- Merge P + N
- Settle
- Redeem P
- Redeem N

Empty state:

> **No positions yet**
> Lock tokenized equity to create P and N, or buy a claim from a market.

Actions: **Explore markets** and **Create demo assets**.

## Phase 5: market terminal

### 5.1 Header and strategy

Header format:

> # Demo Stock · `$150` strike · Sep 15, 2026

Metadata: status, expiry, time remaining, underlying mint, settlement feed, and series
address. Use **All markets** for the back action.

Default strategy mode:

- **Sell upside** selects N selling and reveals claim creation/merge controls.
- **Buy upside** selects N buying and hides collateral creation controls.
- **Advanced trading** exposes P/N and Buy/Sell combinations.

This prevents “I want upside” from producing a contradictory P-market ticket.

### 5.2 Create or merge claims

Rename the section to **Create or merge claims**.

Input: **Tokenized equity to lock**.

Actions:

- **Lock and mint P + N**
- **Merge P + N and unlock**

Explain that merging requires equal P and N balances and immediately returns the
original collateral.

### 5.3 Trading workspace and education

- Put market identity, chart, order book, order ticket, and balances before payoff or
  protocol education.
- Keep payoff, oracle details, risks, and technical addresses in tabs below trading.
- Keep “Payout is not profit.”
- For N purchases, calculate maximum loss, maximum cost, break-even at expiry, expiry
  date, and required settlement price.
- Rename Size to **Quantity**.
- Rename Remaining to **Balance after order**.
- Use **Maximum cost** for buys and **Minimum proceeds** for sells.
- Add a plain-language confirmation summary, for example:

  > Buy up to 10 N at no more than 1.20 USDC each. Maximum cost: 12 USDC. Partial
  > fills allowed.

### 5.4 Market initialization and tabs

- Initialize the Manifest market and MagicBlock execution session automatically as
  part of administrator market listing.
- Do not expose create-book, custody preparation, deposit preparation, or activation
  buttons to a trader. Prepare the required order accounts when the order is submitted.
- Give Depth chart and My activity real empty states before initialization, or mark
  them visibly unavailable.
- Change a missing market parameter to:

  > **No market selected**
  > Choose a market to view its order book and payoff.

- Reserve “unavailable” for a market address that cannot be read on the active cluster.

## Phase 6: Demo setup and Admin registry

### 6.1 Demo setup

Rename the page to **Create demo assets**.

Progress:

1. Demo stock
2. Demo USDC
3. List market
4. Trade

Persistent warning:

> **Devnet only:** these assets are not stocks, securities, or real USDC and have no
> value.

Use:

- **Mint demo stock**
- **Amount to mint**
- **Your demo assets**
- **Simulate stock splits** — Adds Token-2022 Scaled UI support.
- **Simulate issuer control** — Adds a permanent delegate that can move tokens,
  modelling issuer-controlled tokenized assets.

### 6.2 Admin registry

Move the screen to `/admin/registry` and use:

> # Admin registry
>
> Approve settlement feeds and collateral types, then list markets in Erodoro
> discovery.

Rename the task to **List a market** with fields:

- Underlying token mint
- Strike price (USD)
- Days until expiry

Primary action: **Approve collateral and create market**.

Requirements:

- Explain before signing that a new collateral mint needs approval and creation
  transactions.
- Persist completed on-chain steps by reading chain state, not local-only completion
  flags.
- If creation fails after approval, retry from creation.
- Keep one-time network setup collapsed after completion.
- Make the SOL/USD devnet pricing limitation prominent.
- Explain that permissionless series work outside discovery, while only approved
  markets appear in Erodoro.

## Phase 7: onboarding and transaction feedback

### 7.1 Guided demo

Use four steps:

1. **Choose a demo account** — Seller owns demo stock; Buyer owns demo USDC.
2. **Choose a market** — Compare underlying, strike, and expiry.
3. **Choose an action** — Sellers create and offer N; buyers purchase N.
4. **Track the position** — Portfolio shows balances and post-settlement claims.

Show a small **Start guided demo** card on first visit. Do not automatically cover the
entire application on every visit. The manual Guide control must continue to restart it.

### 7.2 Transaction lifecycle

Every transaction-producing control must show:

1. Awaiting wallet approval
2. Submitted
3. Confirming
4. Success with an explorer link
5. Rejected without a framework error overlay
6. Failed with a decoded reason and retry action

Multi-transaction tasks must show named steps, completed steps, the current transaction,
and the step from which retry will resume. User rejection is a normal cancelled state,
not an application exception.

## Phase 8: verification

### Automated checks

- Unit-test payoff text and values at every boundary listed in Phase 1.
- Add a terminology policy test for retired user-facing labels.
- Test route metadata, canonical navigation, and compatibility redirects.
- Test the zero-signature oracle alert, safe configuration, stale quote, and missing
  configuration states.
- Browser-test Markets, Portfolio, Demo setup, Admin registry, and market terminal on
  desktop and mobile.
- Verify disconnected-wallet visibility and signer-only action gating.
- Verify simple strategy mode cannot show a contradictory P trade.
- Verify advanced trading retains valid P and N order entry.
- Test transaction lifecycle states with mocked wallet approval, rejection, RPC
  failure, decoded program failure, and confirmation timeout.
- Keep hydration and static-export checks in the browser suite.

### Live devnet transaction pass

Automated UI tests do not replace this pass. Use throwaway devnet identities and record
transaction signatures for:

| Flow | Required result |
| --- | --- |
| Mint demo stock | Asset appears with extensions and balance |
| Mint demo USDC | Buyer funding appears |
| Approve collateral | Registry state is readable after refresh |
| Create market | Market appears in discovery |
| Initialize Manifest market | Canonical N/USDC book is created |
| Activate MagicBlock | Book changes from read-only to live |
| Lock collateral | Equal P and N balances appear |
| Merge claims | Equal P and N burn and collateral returns |
| Place ask and bid | Both mutations use MagicBlock |
| Partial fill | Remaining quantity and balances are correct |
| Cancel | Locked balance becomes available again |
| Settle | Frozen P and N pools match the oracle result |
| Redeem P and N | Proportional collateral reaches each holder |

Failure paths to record:

- User rejects wallet approval.
- Wrong administrator attempts approval/listing.
- Insufficient collateral or USDC.
- Market is not delegated to MagicBlock.
- MagicBlock read or mutation endpoint is unavailable.
- Oracle quote is stale, unconfigured, or below the required signature threshold.
- A multi-transaction setup fails after an earlier transaction succeeded.

## Delivery checkpoints

1. **Safety patch:** payoff correctness, oracle warning, CTA state, Hedge removal, and
   focused unit/browser tests.
2. **Information architecture:** canonical routes, Portfolio identity, Admin registry,
   application navigation, and terminology helpers.
3. **Surface redesign:** landing page, Markets, Portfolio, terminal, demo setup, admin
   setup, and onboarding.
4. **Transaction hardening:** lifecycle feedback, resumable multi-transaction flows,
   full automated suite, and recorded live-devnet verification.

The work is complete only after all four checkpoints pass and the live devnet matrix has
evidence for both success and failure paths. Passing static UI tests alone is not enough.
