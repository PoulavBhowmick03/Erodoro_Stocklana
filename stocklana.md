# Erodoro Protocol — Polish & Mainnet-Push Plan (Stocklana Hackathon Week)

## Context

Erodoro is being pushed toward a genuinely usable, mainnet-capable state during
Stocklana hackathon week (Solana Foundation, $100K prize pool, submissions
close **Fri Sep 18, 4pm ET** — 6 days from today). The repo currently reflects
months of real prior work (devnet deployed, MagicBlock trading verified-live
on 8 books) but has explicit, documented gaps: no external audit, mainnet is
`configuration-only` with all program addresses null, the rollup session has
never been exercised end-to-end, and several UX/market-data rough edges are
already tracked in `docs/known-limitations.md` and `docs/ux-remediation-plan.md`.

User decisions binding this plan:
- **Target mainnet**, accepting the real-funds risk that implies.
- **No third-party audit** (no budget) — substitute internal cross-review
  between a Claude agent and a Codex agent on the highest-risk code, plus
  expanded adversarial test coverage. This is explicitly *not* equivalent to
  a real audit, and nothing produced this week may claim otherwise.
- **Internal hardening only** for test depth — no external audit engagement.
- **Do** run a competitor-research + Google Stitch design workstream, but
  restyle within the existing bespoke design system rather than replace it.
- Execute within hackathon week, but write later phases so they hold up as a
  genuine post-hackathon roadmap, not just hackathon theater.

Team: **2 Claude Code agents + 2 Codex agents**, run in parallel, with a
structural cross-review pairing (one Claude + one Codex, neither the author)
on the highest-financial-risk contract code — this is the closest available
substitute for a paid audit.

Two corrections surfaced during research that change what's achievable this
week (details in Workstream A):
1. ~~The MagicBlock fee-vault fix is **not** purely an upstream blocker — the
   31-line patch already exists at
   `patches/ephemeral-spl-token-delegated-owner-fee-vault.patch` and can be
   built and deployed under Erodoro's own program ID this week.~~ **Resolved
   2026-09-12, differently:** the blockage was the Manifest fork dropping the
   fee-vault account, not the e-token program. The fork now forwards it on
   both undelegate CPIs (devnet build sha256 `42bdbc45…`, slot 496844170),
   the public ER re-cloned it, and exit plus L1 claims pass. Do **not** apply
   `patches/ephemeral-spl-token-delegated-owner-fee-vault.patch` — upstream
   took it over as `magicblock-labs/ephemeral-spl-token` PR #136 (hardened)
   and that shape is superseded. Evidence:
   `/Users/rahul/work/stellar/erodoro-protocol/docs/evidence/manifest-feevault-deploy-and-session.txt`.
   What stays genuinely outside this team's control is getting the *canonical
   public* Manifest/e-token deployment patched.
2. Three of the five Pinocchio variants (`oracle-adapter-pinocchio`,
   `factory-pinocchio`, `market-pinocchio`) are **already the deployed devnet
   binaries**, not a comparison exercise — confirmed by `CHANGELOG.md`
   ("Deploy cost for the four programs went from 8.9230 SOL to 3.5070 SOL...
   Three of the four are on Pinocchio; series is not") and the `Makefile`'s
   `variants` build loop. The mainnet-ship decision per program is a real,
   live decision this week must make explicitly, not a hypothetical.

## Team topology

| Agent | Role | Owns |
|---|---|---|
| **Claude-A** | Workstream A implementer | Contract hardening, release engineering, mainnet decisions |
| **Codex-A** | Workstream B implementer **+ Codex-side reviewer of A** | Test coverage, rollup e2e, adversarial tests, live-devnet matrix |
| **Codex-B** | Workstream C implementer | Frontend/UX polish, design research |
| **Claude-B** | Workstream D implementer **+ Claude-side reviewer of A** | Ops, monitoring, cross-review coordination, deployment sequencing |

Claude-A writes the highest-risk code (`programs/series`, Token-2022 issuer-lever
handling, the market-vs-Pinocchio deploy call). Claude-B and Codex-A each
independently review it — one Claude, one Codex, neither the author — filing
into a shared findings doc that Claude-B reconciles. No agent merges anything
touching `programs/` without at least one other agent's review.

**Coordination:** a shared `docs/hackathon-week-log.md`, updated daily by every
agent (what shipped, what's blocked, what moved from planned → verified), plus
`docs/cross-review-findings.md` for the review pairing.

## Schedule skeleton (Sep 12 → Sep 18 4pm ET)

Cadence, not a rigid gate — re-sequence daily via the shared log if something
blocks early.

- **Day 0 (today):** Read workstreams + underlying docs. Claude-A starts the
  multisig rehearsal (§A.1). Codex-A stands up a local MagicBlock stack,
  attempts `pnpm rollup` for the first time ever (§B.1). Codex-B starts
  competitor research (§C.1). Claude-B stands up the shared logs, extends
  `scripts/monitor.ts` (§D.1).
- **Day 1:** A: TVL/deposit caps + oracle/issuer policy workflow. B: gets
  `pnpm rollup` green, starts `common/src/math.rs` fuzzing. C: finishes
  competitor research, drafts Stitch prompts. D: reviews A's early diffs.
- **Day 2:** A: stale-IDL `oracle_adapter` devnet redeploy, drafts direct-to-
  multisig mainnet deploy runbook, opens the Pinocchio deploy-decision doc.
  B: adversarial coverage (permanent-delegate mid-redemption drain, hook armed
  mid-session), starts the live-devnet transaction matrix. C: terminology/
  6-state tx lifecycle verification, removes dead custody-exit code. D: drafts
  incident-response runbook v1.
- **Day 3:** ~~A: builds/deploys the patched e-token fork under Erodoro's own
  program ID on devnet (§A.5).~~ A.5 landed 2026-09-12 in the sibling repo
  (fee-vault forwarding in the Manifest fork, devnet-proven). B: runs
  `tests/manifest-fork-rollup.ts` against that deployment — highest-value proof point of the week if it lands. C:
  scopes market-data gaps, ships what's feasible. D: finalizes the `series` +
  Token-2022 cross-review findings.
- **Day 4:** A: finishes caps/policy workflow, closes the Pinocchio decision
  in writing. B: finishes adversarial suite, runs the full live-devnet matrix,
  records evidence. C: ships the Stitch-informed visual pass, re-runs
  `pnpm test:audit`. D: integrates C's changes, simulates a monitor breach
  end-to-end.
- **Day 5:** Buffer/hardening day. Full CI green. All cross-review findings
  resolved or explicitly deferred with a written reason. Docs updated.
- **Day 6 (Sep 18 morning):** Freeze, package submission, submit well before
  4pm ET — don't let the deadline be the first time the full suite runs together.

---

## Workstream A — Contract hardening + mainnet release engineering
**Owner:** Claude-A. **Reviewed by:** Codex-A + Claude-B.

**Goal:** close as many of the 7 `mainnet-promotion.md` release gates as are
honestly closeable without money or a paid audit; for the rest, produce an
executed rehearsal plus a written scope-fence. Make the Pinocchio-vs-Anchor
mainnet ship decision per program, in writing.

**Key files:** `docs/multisig-migration.md`, `docs/mainnet-promotion.md`,
`docs/decisions.md` (§1 admin model), `SECURITY.md`,
`programs/series/src/{lib,state,logic,error}.rs`, `programs/factory/src/lib.rs`,
`programs/oracle-adapter/`, `programs/market/src/{lib,state,logic}.rs`,
`patches/ephemeral-spl-token-delegated-owner-fee-vault.patch`,
`scripts/preflight.ts`, `scripts/migrate-devnet-factory-admin.mjs`,
`deployments/{devnet,mainnet}.json`, `variants/COMPARISON.md`.

**Ordered tasks:**

1. **Multisig rehearsal** — execute (don't redesign) `docs/multisig-migration.md`
   §§1–3 for real on devnet: stand up a Squads multisig (threshold > 1, keys on
   separate hardware/people), transfer the 4 devnet program authorities in the
   documented order, and **prove the quorum can execute a real no-op upgrade**
   before calling this done. For the actual first mainnet deploy, recommend
   deploying each program directly with `--upgrade-authority <SQUADS_VAULT>`
   from genesis rather than a hot-key transfer dance. Run `pnpm preflight`
   and confirm `ok` (not `warn`) on all 4 programs.
2. **Fix the stale devnet `oracle_adapter` IDL skip** — redeploy (~1.55 SOL),
   confirm `pnpm devnet` runs the real suite against live Pyth instead of
   `this.skip()`.
3. **TVL / deposit caps** — the load-bearing mitigation for shipping without
   an audit; must be real, not cosmetic. Add a per-series or per-factory-policy
   collateral cap enforced in `split` (reject once cap is hit), surfaced
   on-chain (not just UI) so `scripts/monitor.ts` can watch utilization.
   Recommend the cap live on the `factory` policy layer, consistent with
   `docs/decisions.md`'s "registry decides what's canonical."
4. **Issuer/oracle policy approval workflow** — turn the two "not approved"
   gates from an unrecorded human decision into an on-chain-anchored approval
   record (reviewer, timestamp, feed id, confidence/staleness bounds, dividend-
   schedule check) inside `programs/factory`'s approve instructions. Do **not**
   attempt to move Backed's TSLAx mint out of `candidate-not-approved` —
   that's issuer/legal review, explicitly out of scope.
5. ~~**Apply, build, deploy, prove the fee-vault patch** — obtain the pinned
   `ephemeral-spl-token` and Manifest core commits named in
   `docs/manifest-magicblock-spike.md`, apply the existing patch, deploy under
   Erodoro's own program ID on devnet (the "separately maintained GPL fork"
   the spike doc already recommends). Hand the program ID to Workstream B. If
   source access to those repos doesn't exist, say so explicitly and stop —
   don't simulate success.~~ **Done 2026-09-12 in the sibling repo
   (`erodoro-protocol` commit `48d01d6`, merged as `73fd577`): fee-vault
   forwarding landed in the Manifest fork, deployed to devnet, ER re-cloned,
   pre-existing session exit plus a fresh full lifecycle both pass. Remaining
   for this workspace: mirror the deployment record (done in
   `deployments/devnet.json`) and keep the seat-regression caveat visible
   (seats must be claimed on L1 before delegation). Do not re-apply the old
   patch shape.**
6. **Permissionless maturity cancel/exit** — confirm `programs/market`'s own
   fallback CLOB is already permissionless on this axis (`cancel_order` allows
   any trader to cancel their own resting order any time; `undelegate_book`/
   `commit_book` take a bare signer, no special authority). Spend real effort
   on the Manifest-fork/e-token custody side instead: add a
   `force_cancel_expired_orders`-style instruction, callable by anyone once
   `now >= maturity_ts`, so an absent counterparty can never permanently block
   exit.
7. **Pinocchio ship decision, written down** (append to `variants/COMPARISON.md`
   or a new `docs/mainnet-binary-decision.md`):
   - `oracle-adapter-pinocchio`, `factory-pinocchio` → recommend **ship**
     (medium risk, no collateral custody, covered by conformance suites, real
     rent savings matter with no audit budget).
   - `market-pinocchio` → recommend **do not ship for first mainnet
     deployment** — ranked highest-risk in `audit-brief.md`, holds real trader
     deposits, `SECURITY.md` explicitly disclaims internal review of its
     escrow ledger. Deploy the Anchor `market` build at launch; keep the
     Pinocchio port on devnet as the differential-test target.
   - `series-pinocchio`, `oracle-adapter-quasar` → confirm **research-only**,
     unchanged (neither is in the Makefile's deploy loop).

**Definition of done:** `pnpm preflight` reports `ok` on all 4 devnet
authorities with an executed no-op multisig upgrade recorded; `pnpm devnet`
runs the real oracle suite; a cap-enforcement test passes in
`cargo test --workspace`; an on-chain policy-approval record exists and is
monitor-readable; the Pinocchio ship decision is written and countersigned by
both cross-reviewers; `docs/mainnet-promotion.md`'s gate table is updated with
an honest status (closed / rehearsed-not-executed / deferred-with-reason) for
all 7 gates.

---

## Workstream B — Test coverage: wire every suite in, run the rollup for real, adversarial tests
**Owner:** Codex-A (also Codex-side reviewer of A).

**Key files:** `tests/{rollup-session,manifest-ephemeral,manifest-fork-rollup,
devnet-oracle,devnet-market}.ts`, `common/src/math.rs`,
`programs/series/src/logic.rs`, `programs/market/src/{logic,state}.rs`,
`Makefile`, `scripts/monitor.ts`, `docs/ux-remediation-plan.md`.

**Ordered tasks:**

1. **Run the rollup for the first time ever.** Per `docs/audit-brief.md`, the
   four delegation instructions have never been executed anywhere. Stand up a
   local MagicBlock stack, run `pnpm rollup` (`tests/rollup-session.ts`),
   capture real latency numbers against `docs/magicblock.md`'s recorded ones.
2. **Run the Manifest-fork lifecycle** against Workstream A's fresh deployment
   (§A.5, landed 2026-09-12 — dependency satisfied) — full deposit→delegate→match→cancel→commit→undelegate→
   withdraw with exact balance conservation. If A.5 didn't land a deployment,
   run `tests/manifest-ephemeral.ts` instead and record exactly why the fork
   test couldn't run.
3. **Wire remaining suites into a documented local tier** — add
   `rollup-manifest-fork` / `devnet-manifest-ephemeral` Makefile targets
   mirroring the existing `rollup`/`devnet` pattern (same `assert_ran` guard so
   a skip can never silently read as a pass). Document in `ci.yml` why these
   stay outside hosted CI (no MagicBlock stack on a GitHub runner).
4. **Fuzz the math/settlement core** with `proptest` (add as dev-dependency,
   picked up free by the existing `cargo test --workspace` CI job):
   - `checked_mul_div_floor`/`checked_mul_div_ceil` (`common/src/math.rs`) —
     full `i128` domain, floor/ceil bound + no overflow/underflow.
   - `compute_pools` — fuzz `(collateral, strike, price)` asserting
     `p_pool + n_pool == collateral` always, including edge values.
   - `effective_strike` + `resolve_multiplier` — fuzz ratios near
     `MAX_MULTIPLIER` and near-zero, rounding-favors-P must hold everywhere.
   - `apply_shortfall` / `redeem_payout` — fuzz redemption orderings, assert
     `total_paid <= available` always.
5. **Adversarial scenarios**, grounded in `SECURITY.md`'s threat table:
   - Oracle right at the settlement-window boundary (one second in/out).
   - Permanent-delegate drain happening *mid-redemption* (some holders already
     redeemed before the drain), not just before any redemption.
   - Transfer hook armed *after* series creation, mid-lifecycle (between
     split and settle).
   - Self-fill and withdraw-more-than-free-balance on `market`, pre- and
     post-maturity.
   - Vault-vs-ledger conservation after several rounds of in-rollup trading
     and a commit, checked via `scripts/monitor.ts`.
6. **Execute the live-devnet transaction pass matrix** from
   `docs/ux-remediation-plan.md` Phase 8 (never yet recorded as evidence) —
   walk every row (mint, approve collateral, create market, lock, merge,
   place/fill/cancel orders, settle, redeem P and N) plus every failure path,
   recording transaction signatures into `docs/live-devnet-evidence.md`.

**Definition of done:** `pnpm rollup` passes against a real local MagicBlock
stack with recorded latencies; at least one Manifest-lifecycle test passes
against a devnet deployment (or the block reason is documented); new
`proptest` cases exist and pass for all five math/logic targets; new
adversarial test cases exist and pass for all five scenarios, referenced in
`docs/audit-brief.md`'s coverage table; the live-devnet matrix has a recorded
signature or documented failure for every row; `docs/ux-remediation-plan.md`
no longer says "final verification pending."

---

## Workstream C — Frontend/UX polish + design research
**Owner:** Codex-B.

**Key files:** `docs/ux-remediation-plan.md`, `web/README.md` (house rules),
`web/app/globals.css`, `web/components/portfolio-screen.tsx`,
`web/lib/capabilities.ts`, `web/components/manifest-book-panel.tsx`,
`web/tests/{ux-policy,transaction-flow,portfolio-orders}.test.mjs`,
`web/{flows,tour,ux-audit}.spec.mjs`, `docs/known-limitations.md`.

**Ordered tasks:**

1. **Competitor research + Google Stitch prompts.** Research Hyperliquid,
   Drift, Jupiter, Zeta-style trading UI conventions plus general fintech/
   design-company inspiration via web search. Produce `docs/design-research.md`
   with concrete observations (order-book density, position tables, tx-
   lifecycle feedback, theming), then draft **ready-to-run Google Stitch
   prompts** per screen (terminal, portfolio, landing) that encode Erodoro's
   house rules as explicit constraints in the prompt itself (no floor/
   protection language, no invented metrics, square corners on landing, warm
   cream/charcoal + terracotta palette, Geist+Jost+editorial-serif, no Three.js/
   WebGL). Default is restyle-within-the-system; a compelling deviation needs
   explicit sign-off from Workstream D before being treated as in-scope.
2. **Verify (don't assume) the ux-remediation-plan.md "done" items** —
   cross-check terminology enforcement, the 6-state transaction lifecycle, and
   trading-workspace-first ordering against actual source and tests, not just
   the doc's claim.
3. **Remove the dead custody-exit code path** — `portfolio-screen.tsx`'s
   `onReturnToWallet` throws and is gated behind a capability that's `false`
   everywhere; delete the dead throwing function/call site rather than leaving
   a landmine, update `web/tests/capabilities.test.mjs` accordingly.
4. **Market-data gaps** — batch the market directory's per-row RPC calls into
   `getMultipleAccountsInfo` (mirror `scripts/monitor.ts`'s `batched()`
   pattern); do not attempt a real trade-history indexer this week (no
   infra/budget) — instead verify in-app copy matches `docs/known-limitations.md`'s
   honest framing, and consider a client-side rolling-window price cache as an
   explicitly-labeled stopgap, not a real metric.

**Definition of done:** `docs/design-research.md` exists with named
observations and ≥3 ready-to-run Stitch prompts including house-rule
constraints; `pnpm --dir web test:unit`, `test:tour`, and `test:audit` all
pass after changes with no new contrast/hydration/overflow regressions; the
dead custody-exit throw is gone; the market directory issues one batched call
per load instead of per-row; docs and in-app copy agree on the volume/history
gap.

---

## Workstream D — Integration, ops, and cross-review coordination
**Owner:** Claude-B (also Claude-side reviewer of A).

**Key files:** `scripts/monitor.ts`, `scripts/preflight.ts`,
`docs/{mainnet-promotion,audit-brief,known-limitations}.md`, `SECURITY.md`,
`CHANGELOG.md`, new `docs/cross-review-findings.md` and
`docs/incident-response.md`, `programs/series/src/{lib,collateral}.rs`,
`programs/market/src/lib.rs`.

**Ordered tasks:**

1. **Extend `scripts/monitor.ts`** — add a warn-threshold check against
   Workstream A's new TVL cap; add a check that a canonical series' collateral/
   oracle has a recorded `PolicyApproval`; confirm the alert webhook is wired
   to a real channel; add both new checks to `selfTest()` so `pnpm
   monitor:self-test` (already in CI) exercises every alarm at least once.
2. **Incident-response runbook** (`docs/incident-response.md`) — what to do on
   a monitor `breach` vs `warn`, what read-only diagnostics to run first, and
   an honest statement of what the contracts can and can't do in response
   (e.g., `pause_splits` requires that specific series' admin key — if
   compromised, the only remedy is the multisig-authority chain).
3. **Coordinate and execute the cross-review** on `programs/series`
   settlement/collateral logic and Token-2022 issuer-lever handling — the
   highest financial-risk code. Claude-B and Codex-A each independently read
   the code (without reading each other's notes first), file into
   `docs/cross-review-findings.md` under their own name, then Claude-B
   reconciles severity (high/medium/low, matching `SECURITY.md`'s convention).
   Extend to `programs/market` if time allows. High findings block merge.
   **State plainly in the findings doc and in `docs/audit-brief.md` that this
   is two more sets of eyes, not an audit** — this must not be represented
   otherwise anywhere (README, pitch deck, docs).
4. **Integrate Workstream C's output** — full `pnpm --dir web build && pnpm
   --dir web test:ux` after C's changes land, reconcile capability-gating
   changes against mainnet env vars.
5. **Own deployment sequencing and doc updates** — update
   `docs/mainnet-promotion.md`'s gate list and `deployments/mainnet.json`
   precisely (do not flip `ready: true` — that would be false), add a dated
   `CHANGELOG.md` entry, update `SECURITY.md` if the cross-review found and
   fixed anything.

**Definition of done:** `pnpm monitor:self-test` fires every alarm including
the new checks; `docs/incident-response.md` is specific enough for a first
responder with no prior context; `docs/cross-review-findings.md` has
independently-sourced, severity-tagged findings each resolved or explicitly
deferred, countersigned by both reviewers; `docs/mainnet-promotion.md`'s gate
list is honestly updated; `CHANGELOG.md`/`SECURITY.md` reflect the week's work.

---

## Cross-review protocol

1. Claude-A lands a diff touching `programs/series` (or `programs/market`).
2. Claude-B and Codex-A each independently review the diff *and* the
   surrounding unchanged code in the same files — a fresh read of the whole
   path, not just the new lines.
3. Both file findings into `docs/cross-review-findings.md` under their own
   name before comparing notes.
4. Claude-B reconciles: findings both reviewers independently raised are
   highest-confidence; single-reviewer findings get a second look before
   dismissal.
5. High findings block merge; medium/low get fixed this week or explicitly
   deferred with a written reason.
6. This does not substitute for a paid, independent, adversarial third-party
   audit — say so in the findings doc itself.

## What does NOT get resolved this week, regardless of effort

- **The canonical public MagicBlock/Manifest fee-vault deployment.** Even if
  Workstream A's own-program-ID fork succeeds, getting it accepted into the
  *canonical* shared deployment is outside this team's control on any
  timeline. Mainnet trading via the rollup order book may remain dependent on
  a self-run fork.
- **The GPL-3.0/Apache-2.0 licensing question** on the Manifest fork — a legal
  decision, not an engineering one. Don't paper over it.
- **A real external audit.** Nothing this week substitutes for one, and
  nothing produced may be described as equivalent to one, anywhere.
- **Backed's TSLAx mint leaving `candidate-not-approved`** — issuer/legal
  review, not engineering.
- **N-side market maker recruitment** — a commercial problem per
  `docs/decisions.md`, untouched by contract work.
- **Actually flipping `deployments/mainnet.json`'s `ready` to `true` or moving
  real capital.** This plan gets the protocol *ready to consider* a capped
  mainnet deploy; that decision should follow this week's work with fresh
  eyes, not be rushed to meet the hackathon deadline.
- **`market`'s escrow ledger reaching the same review depth as `series`** —
  one week of two-reviewer attention is real work, not audit-equivalent
  scrutiny. Treat any `market` findings as a first pass.

## Post-hackathon roadmap

**Phase 2 (weeks 2–6, still no audit budget assumed):** extend cross-review to
`programs/market` and the shipped Pinocchio ports at `series`-level depth;
build a minimal off-chain trade-history indexer to properly resolve the
volume/price-chart gaps; pursue the upstream fee-vault patch conversation in
parallel with running Erodoro's own fork; resolve the GPL/Apache licensing
question with legal input before any mainnet deploy touching the fork.

**Phase 3 (once there's a funding path):** commission the real external audit
(`docs/audit-brief.md` is already scoped for this — this week's findings
become "already found and fixed," which shortens and cheapens it); formal
verification or independent audit of the Manifest custody additions
specifically; begin real N-side market-maker conversations once there's a
credible, audited product to show.

**Phase 4 (mainnet, staged):** first deployment at a deliberately small TVL
cap, admin held by the proven multisig, series-scoped renouncement considered
only as each series approaches maturity; cap increases gated on elapsed
no-breach time, at least one completed real settlement cycle, and ideally the
real audit landing. The permanent-delegate risk in `SECURITY.md`'s threat
model never disappears — it's a property of the collateral, not a fixable bug.

## Verification

- **Contracts:** `cargo test --workspace` (native + new proptest/adversarial
  cases), `make pinocchio-oracle` / `pinocchio-factory` / `pinocchio-market`,
  `make e2e`, `pnpm rollup`, `pnpm devnet`, `pnpm devnet-market`, the new
  `rollup-manifest-fork` / `devnet-manifest-ephemeral` targets.
- **Ops:** `pnpm preflight` (expect `ok` on all 4 programs), `pnpm
  monitor:self-test` (every alarm fires).
- **Frontend:** `pnpm --dir web test:unit`, `test:tour`, `test:audit`,
  `pnpm --dir web build`.
- **Process evidence:** `docs/live-devnet-evidence.md` (signature per matrix
  row), `docs/cross-review-findings.md` (countersigned, severities resolved
  or deferred), `docs/hackathon-week-log.md` (daily status from all 4 agents).
- **Docs honesty check before submission:** `docs/mainnet-promotion.md`'s gate
  table, `deployments/mainnet.json`, `SECURITY.md`, and any submission/pitch
  copy must all agree on what's actually closed vs rehearsed vs deferred —
  no claim of audit-equivalence anywhere.
