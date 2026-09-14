# Ephemeral SPL-token integration review

Date: 2026-08-18

Status: engineering security review, not an independent third-party audit.

## Scope

- Erodoro's canonical Manifest market lifecycle.
- The additive Manifest instructions `18`–`20` for projected deposits,
  projected withdrawals, and L1 claims.
- Market eATA setup and undelegation through MagicBlock.
- The optional Magic fee-vault change in the Erodoro
  `ephemeral-spl-token` fork.
- Browser instruction construction and the local two-validator lifecycle test.

The upstream Manifest matching engine and upstream e-token global-vault logic
were treated as dependencies. This review does not replace their audits.

## Custody model

For each market mint, e-token holds the real L1 tokens in its global vault and
records the market's balance in `eATA(market PDA, mint)`. MagicBlock projects
that eATA at `ATA(market PDA, mint)`. While the session is active, Manifest
moves Tokenkeg balances between a trader's projected ATA and the market's
projected ATA, and makes the identical debit or credit in the trader's
Manifest seat.

On exit, Manifest requires an empty order book, asks e-token to commit and
undelegate both market ATAs, then commits and undelegates the market account.
After restoration on L1, a trader claims with one atomic transaction that
debits their Manifest seat and invokes e-token's global-vault withdrawal with
the canonical market PDA as signer.

The intended conservation invariant for each mint is:

```text
market eATA amount == sum(all seat withdrawable + all resting-order balances)
```

## Findings fixed

### High — mixed custody could create ambiguous liabilities

Canonical markets previously retained Manifest's legacy vault deposit and
withdraw instructions. Mixing those balances with e-token balances would make
the internal ledger impossible to reconcile to one custody source.

Fix: canonical markets are marked `ephemeral_custody_enabled` at creation and
legacy Deposit, Withdraw, and Swap paths reject them. This is covered by a live
negative test.

### High — exiting with resting orders could strand funds

After exit, BatchUpdate is unavailable and an order's reserved balance is not
withdrawable. A session could therefore restore to L1 with user funds locked in
orders.

Fix: `CommitAndUndelegateMarket` rejects a market whose bid or ask root is not
empty. The two-validator test proves the rejection and then proves exit after
cancellation.

### High — delegated eATA owners require the Magic fee vault

The market PDA is itself delegated. Magic's commit instruction consequently
requires the selected validator's writable fee-vault PDA when e-token uses the
market as the payer. Upstream e-token instruction `5` accepted exactly five
accounts and always passed `None` for this value, causing exit to fail with
`invalid magic fee vault account`.

Fix in the Erodoro e-token fork: instruction `5` accepts one optional sixth
account and forwards it to `commit_and_undelegate_accounts`. Manifest derives
and supplies that validator fee vault. The patched e-token SBF passed the full
exit and claim lifecycle locally.

Deployment condition: this e-token patch must be accepted upstream or the
patched e-token program must be deployed under an agreed program ID before the
integration is production-ready. The currently published program cannot
complete this delegated-owner exit path.

### Medium — substituted token accounts could redirect value

Fix: deposit and projected withdrawal require Tokenkeg, a traded mint, the
trader's canonical ATA, and the canonical ATA owned by the market PDA. Claims
also validate the market eATA, per-mint global-vault PDA, global-vault ATA,
trader ATA, mint program, and e-token executable ID.

### Medium — claim replay or cross-trader claim

Fix: the transaction signer is resolved to their claimed Manifest seat before
the seat is debited. The e-token withdrawal and Manifest debit are one atomic
transaction. A live test proves that a second claim fails.

## Residual risks and limitations

- Only classic Tokenkeg mints are supported. Token-2022 transfer fees and
  extensions are intentionally rejected until their projection semantics and
  balance-delta accounting are tested end to end.
- The e-token optional fee-vault change is not yet part of the upstream
  published program. This is a release blocker, not a documentation-only item.
- The session authority controls when the market is delegated, committed, and
  exited. It cannot take trader tokens, but it can delay settlement. Operational
  automation and a permissionless maturity escape path should be reviewed
  before mainnet.
- An uncooperative trader can leave resting orders and prevent exit. A
  permissionless cancel-all-after-maturity path would reduce this liveness
  risk while preserving the no-locked-funds invariant.
- The added custody state and instructions have not been covered by Manifest's
  existing Certora specifications or by an external auditor.
- MagicBlock validator behavior, e-token's global vault, and the Delegation
  Program remain trusted dependencies.

## Verification performed

- Manifest native unit suite with the `ephemeral` feature (66 tests).
- Manifest TypeScript instruction serialization tests.
- e-token SBF build with platform-tools v1.54.
- Next.js TypeScript checking and production build.
- Local MagicBlock stack with a base validator and ephemeral validator:
  - real Tokenkeg mint and global-vault deposits;
  - trader and market eATA delegation;
  - projected deposits into Manifest seats;
  - maker/taker price-time match;
  - cancellation and commit;
  - rejection of legacy custody;
  - rejection of exit with a resting order;
  - dual market-eATA undelegation with the fee vault;
  - L1 claims and exact four-account token conservation;
  - rejection of a double claim.

## Recommended release gates

1. ~~Land or deploy the e-token optional fee-vault patch and pin its exact commit.~~
   **Satisfied 2026-09-12, differently than written:** the blockage was the
   Manifest fork dropping the fee-vault account, not the e-token program. The
   fork now forwards it on both undelegate CPIs (deployed devnet build sha256
   `42bdbc45…`, slot 496844170), and the canonical e-token deployment accepts
   the optional account, so compatibility is proven by behavior. Upstream took
   over the e-token-side hardening as `magicblock-labs/ephemeral-spl-token`
   PR #136 — do **not** apply `patches/ephemeral-spl-token-delegated-owner-fee-vault.patch`;
   that shape is superseded. Evidence:
   `/Users/rahul/work/stellar/erodoro-protocol/docs/evidence/manifest-feevault-deploy-and-session.txt`.
2. Add the new Manifest custody instructions to formal verification or obtain
   an independent audit.
3. Add a permissionless maturity cancel/exit design.
4. Run the lifecycle against the intended public MagicBlock validator and the
   exact deployed binaries.
5. Keep Token-2022 disabled until an equivalent end-to-end suite passes.
