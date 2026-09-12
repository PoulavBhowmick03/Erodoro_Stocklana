# Security

## Reporting

Report suspected vulnerabilities privately. Do not open a public issue for
anything affecting funds.

## Threat model

The collateral is a Token-2022 mint whose issuer holds four levers over
anything held in a vault. **This is not a protocol whose security can exceed
the issuer's honesty**, and the design says so rather than papering over it:

| Lever | What the issuer can do | What the protocol does |
| --- | --- | --- |
| `permanentDelegate` | Move or burn collateral out of a vault, at any time, with no consent | Redemption prices the shortfall proportionally instead of paying first-come (§7); `ShortfallObserved` fires on-chain |
| `pausableConfig` | Halt all transfers globally | `split`/`merge`/`redeem_*` revert loudly; `settle` still works, so a pause delays redemption rather than losing it |
| freeze authority | Freeze the vault's token account | Same as a pause, scoped to one series |
| `transferHook` | Arm a blocklist without redeploying the mint | Every transfer resolves hook accounts from day one (§9), proven by a test against an armed hook |
| `scaledUiAmount` | Rebase every balance for a corporate action | The strike is adjusted by the same ratio at settlement (§6) |

The permanent delegate is the strongest lever the issuer holds. It is the
one way `P` can be short at maturity through no fault of the contract, and it
belongs in the UI as a headline risk, not a footnote.

## Findings from the internal review

Six issues found and fixed before any mainnet deployment. The first three are
structural: each comes from an assumption that stops holding once claim tokens
are plain SPL mints and series creation is permissionless.

### 1. `settle` could be bricked permanently — high

The obvious implementation gates settlement on `p_supply == n_supply` and
`collateral >= p_supply`. Either condition is a permanent denial of service:

- `P` and `N` are plain SPL mints, so **any holder can burn their own tokens**
  outside the protocol. Burning one raw unit makes the supplies disagree
  forever. `settle` would revert on every subsequent call, and `merge` is
  already closed after maturity — every holder's collateral stranded for good,
  at a cost to the attacker of one token unit.
- The permanent delegate can drain the vault *before* maturity as easily as
  after, so a collateral gate hands the issuer a way to freeze a series rather
  than merely to take from it.

Neither condition threatens solvency, which is what those checks were actually
protecting: `compute_pools` partitions whatever collateral is present, so
`p_pool + n_pool == collateral` regardless of supplies, and each side pays at
most its own pool. A holder who burns their claim forfeits to the rest of
their own side.

**Fixed** by recording both conditions on the `Settlement` account
(`supply_mismatch`, `shortfall_observed`) and proceeding — the same posture §7
already takes on a post-settlement drain: price it, do not gate it. Regression
tests at both the unit and end-to-end level.

### 2. Series addresses could be squatted — high

Series creation is permissionless by design, and the PDA was seeded on
`(collateral_mint, strike, maturity_ts)` alone. That names exactly one address
protocol-wide, so an attacker could watch for a factory creation, front-run it,
and occupy the address — making the canonical series for those parameters
impossible to create, permanently, for the cost of rent. The squatted series
would also carry the attacker as `admin`.

**Fixed** by seeding on the creator as well. Every creator gets their own
address space, so the factory's cannot be occupied by anyone else. Creation
stays permissionless; the registry still decides what is canonical.

### 3. An oracle admin could swap a Pyth feed for a mock — medium

`set_source` accepted a new `source_kind`. Quotes are checked against the
config's `feed_id`, but a mock feed can claim any id it likes — so an admin
able to flip a `Pyth` config to `Mock` could point a live series at a price
they write themselves and pass every remaining check.

**Fixed** by removing the mock backend entirely. Every read now requires the
source account to be owned by the Pyth receiver, while `set_source` can only
rotate the address. The configured feed id remains immutable and is checked
against every decoded update.

### 4. A series could be impossible to settle — high

Settlement becomes callable at `maturity + settlement_delay`, but an accepted
quote must be no later than `maturity + max_price_lag` and no older than the
tighter of the series and feed staleness bounds. Previously these values were
validated independently. A permitted tuple such as a 3,600-second delay,
900-second price window, and 300-second maximum age leaves every eligible quote
stale before settlement can first run, permanently stranding outstanding
claims after maturity.

**Fixed** by enforcing:

```text
settlement_delay <= max_price_lag + min(series_max_age, feed_max_age)
```

The series program checks the actual feed bound at creation; the factory also
rejects an incoherent policy tuple before its CPI.

### 5. Representable payouts could fail on intermediate overflow — low

Pro-rata math evaluated `amount * pool / supply` in `i128`. Valid account
values are `u64`, and `u64::MAX * u64::MAX` exceeds `i128` even when division
makes the final result fit exactly in `u64`. At that extreme, settlement or
redemption could revert solely because of the intermediate representation.

**Fixed** with checked quotient/remainder accumulation after the ordinary
single-multiplication fast path. Flooring and ceiling semantics are unchanged,
and tests now cover the full `u64` account domain.

### 6. A zero-signature verification floor was valid on-chain — high

The preflight script rejected `min_verification_signatures = 0`, but feed and
series creation did not. This made source authentication an operator checklist
instead of a contract invariant and left non-factory series able to accept a
partially verified update carrying no guardian signatures.

**Fixed** by requiring a non-zero floor when a feed config is initialized and
again when any series binds an existing config. Preflight still reports legacy
accounts created by an older deployment.

## Trust surface, after those fixes

**No admin can touch active collateral.** The series admin can pause and
unpause splits, and sweep dust once both claim supplies are zero. It cannot
settle, cannot change any term, and cannot move collateral out of a live
series. `merge` deliberately works while paused, so a pause can never trap
collateral behind existing claims.

**The factory has no power over a series it created** — not even to pause one.
It controls only which parameters, oracles and collateral mints may become
*canonical*.

**Settlement is permissionless and callable once.** Anyone can poke it; nobody
can choose the price. The quote must carry the series' own feed id, be fresh,
and land inside a settlement window fixed at creation.

**The oracle admin cannot change what a live series settles against** — the
feed id and Pyth-only decoder are fixed. Only the account a Pyth update is read
from can change, and its embedded feed id is checked on every read.

## Known limitations

- **`sweep_dust` takes the whole remaining balance** once both supplies are
  zero. A holder who burns their claim tokens without redeeming forfeits their
  collateral to the fee recipient. That is intended, but a UI must not make
  burning easy to do by accident.
- **The dividend case is unsolved.** The strike ratio is exact for a pure split;
  a cash dividend passed through by rebasing it cannot express. Series creation
  refuses a *known scheduled* multiplier change, which is the conservative half
  of the answer. See `docs/decisions.md`.
- **No external audit.** Everything above is an internal review.
  `docs/audit-brief.md` is the scope and priority order for one, including the
  parts we believe are weakest and the things already known to be wrong.
- **The `market` program is a prototype.** The findings above concern the
  series/oracle lifecycle and must not be read as an audit of its escrow ledger
  or ephemeral-rollup session controls.

## Before mainnet

Run `scripts/preflight.ts` — it checks the live mint's five extensions, the
implemented identity, ownership, freshness, and verification gates on every
feed config, and the upgrade authority of every deployed program. It does not
establish that an equity market was open or choose a confidence-interval
policy.

### Upgrade authority

Preflight **fails** if any program's upgrade authority is a plain wallet.

Every program here can be replaced by whoever holds that authority, and the
`series` vaults hold collateral. A single hot key means the protocol is one key
compromise away from being replaced by something that drains them, and no
on-chain check helps — the checker is the thing being replaced.

It passes on an authority owned by a governance or multisig program (SPL
Governance, Squads v3/v4), or on a program deployed `--final`. An authority
owned by some *other* program is a warning rather than a pass: it may well be a
multisig this script does not know, and that has to be confirmed by a human
rather than assumed.

As of this writing all four devnet deployments fail this check. That is correct
and expected for devnet; it is a blocker for mainnet.

`docs/multisig-migration.md` is the runbook. The order matters more than the
tooling: least important program first, because a wrong vault address is
unrecoverable — and prove the quorum can actually execute an upgrade *before*
transferring `series`, since an authority nobody can exercise is worse than a
hot key, not better.
