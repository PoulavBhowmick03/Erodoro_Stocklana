# Decisions

§14 of the implementation plan lists four questions that "change the contract,
not just the copy," and says to settle them before step 4. Here is where each
one landed and why.

## 1. Does the admin survive?

**Yes, on a minimal surface, with a one-way exit per series.**

The plan states both sides fairly. For: the issuer already holds four kill
switches over the collateral, so a contract admin adds little marginal trust.
Against: it is one more key to lose.

Both are right, and which dominates is not a property of the protocol — it is a
property of the series. A long-dated series over a mint whose issuer has just
armed a transfer hook wants someone able to stop new deposits. A short-dated
one, written and sold in a week, wants nothing that can be compromised.

So the decision is made per series, at runtime:

- The admin can **pause and unpause splits**, and **sweep dust** once both
  claim supplies are zero. That is the entire surface. It cannot settle, cannot
  change any term, and has no path to active collateral. `merge` deliberately
  works while paused, so a pause can never trap collateral behind existing
  claims.
- `renounce_admin` sets the admin to the zero address, permanently. No signer
  can match it afterwards, so all three instructions are dead for the life of
  the series.

The cost of renouncing is that residual dust can never be swept — it stays in
the vault forever. That is the right direction for a trade of convenience
against trust, and it is why renouncing is offered rather than forced.

**Recommendation for the first mainnet series:** keep the admin, held by a
multisig, and renounce once the series is close to maturity and the deposit
window is closed.

## 2. Dividend policy

**Do not open a series spanning a known ex-dividend date. The protocol cannot
solve this and should not pretend to.**

The strike adjustment in §6 is exact for a pure split, because a split is a
clean ratio: balances scale by `k`, the price scales by `1/k`, and scaling the
strike by `1/k` restores the original economics exactly. This is tested in both
directions.

A cash dividend passed through by rebasing is not a clean ratio, and the
adjustment gets it **backwards relative to market convention**:

- Backed raises the multiplier so each raw unit represents more value.
- The per-share oracle price does not move — the dividend is extra units, not a
  higher price.
- `effective_strike = strike * m_creation / m_settlement` therefore *falls*.
- A lower strike means a smaller `p_pool`, so the dividend accrues to **N**.

A real listed option is not strike-adjusted for ordinary dividends at all: the
dividend belongs to whoever holds the stock, which here is P. So a rebased
dividend moves value from P to N, in the wrong direction, by an amount no
on-chain data distinguishes from a split.

**The protocol cannot tell the two apart.** Both arrive as a multiplier change
and nothing else. There is no field, event, or flag on the mint that says
"this rebase was a dividend."

What is enforced: `require_no_scheduled_change` refuses to open a series when a
multiplier change is already scheduled to land before its maturity. That covers
every *announced* corporate action, dividend or split, which in practice is
almost all of them — ex-dividend dates are published weeks ahead.

What is not enforced, and cannot be: an unannounced rebase applied with
immediate effect during a live series. `scripts/preflight.ts` surfaces any
scheduled change before deployment; beyond that this is an operational
constraint on whoever picks maturities, and it belongs in the runbook, not in
the program.

**The UI must state that dividends are not passed through to the P side.**
Leaving this emergent is exactly the failure the plan warns about.

## 3. Which ticker first

**Undecided, and deliberately not decided here.** The plan is right that the
choice should follow order-book depth for the P/N pair rather than the
popularity of the underlying. TSLAx is the worked example throughout the code
and tests because it is the mint whose extensions were verified, not because it
is the recommendation.

Blocked on: measured depth for a P/N pair, which does not exist until something
is listed. See §4.

## 4. Where does N liquidity come from?

**Unsolved. This is the real risk to the product, and no amount of contract
work touches it.**

The contract works with zero traders. The product does not: the P holder needs
somebody to buy N, and the premium from that sale is the *entire* value
proposition — it is the only cushion against a fall, since this is not downside
protection.

Recorded here so it is not mistaken for an engineering problem. Options that
have not been evaluated: seeding a market maker, a Dutch auction at series
creation, or bootstrapping N against an existing options desk. All are
commercial decisions.

## Non-§14 decisions worth recording

**Rounding favours P.** P is the senior claim, so where a rounding choice moves
value between the sides it moves it to P: flooring the normalized price rounds
`p_pool` up, and the effective strike ceilings. Both are asserted in tests
rather than left to emerge.

**Settlement records rather than gates.** Supply mismatches and
under-collateralization at settlement are written to the `Settlement` account
instead of reverting. Reverting would let anyone strand a series permanently by
burning one raw unit of a claim token. See `SECURITY.md`.

**Creation is permissionless; the registry decides what is canonical.** Anyone
can create a series. Front ends must list from the factory's `SeriesRecord` and
never from the `series` program's accounts at large.
