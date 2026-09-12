import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalsRemaining,
  beginFlow,
  describeApprovals,
  isComplete,
  isRunning,
  markActive,
  markAwaiting,
  markDone,
  markFailed,
  planOrderSteps,
  classifyFailure,
} from "../lib/transaction-flow.ts";

// The real helpers are React-free but live beside wallet code, so the classifier
// takes them as arguments. These mirror their production behaviour closely
// enough to pin the branch each message should take.
const helpers = {
  isRejection: (e) => /User rejected|reject/i.test(String(e?.message ?? e)),
  isExpired: (e) => /block height exceeded|expired/i.test(String(e?.message ?? e)),
  explain: (e) => String(e?.message ?? e),
};

const conditions = (overrides = {}) => ({
  claimDeficit: 0,
  baseToDelegate: 0n,
  quoteToDelegate: 0n,
  baseSymbol: "N",
  collateralSymbol: "DEMO",
  ...overrides,
});

test("a fully prepared trader signs exactly once", () => {
  const steps = planOrderSteps(conditions());
  assert.deepEqual(steps.map((step) => step.kind), ["order"]);
  assert.equal(approvalsRemaining(beginFlow("sell", steps)), 1);
  assert.equal(describeApprovals(steps), "1 wallet approval, 1 on MagicBlock.");
});

test("a first order delegates and waits for the projection before ordering", () => {
  const steps = planOrderSteps(conditions({ baseToDelegate: 5n }));
  assert.deepEqual(steps.map((step) => step.kind), ["delegate", "project", "order"]);

  // Waiting for a projection is not a signature request, and counting it as
  // one would overstate what the wallet is about to ask for.
  assert.equal(steps.find((step) => step.kind === "project").approval, false);
  assert.equal(approvalsRemaining(beginFlow("buy", steps)), 2);
  assert.equal(
    describeApprovals(steps),
    "2 wallet approvals: 1 on Solana, 1 on MagicBlock.",
  );
});

test("a seller short of the claim locks collateral first", () => {
  const steps = planOrderSteps(
    conditions({ claimDeficit: 38, baseToDelegate: 100n }),
  );
  assert.deepEqual(steps.map((step) => step.kind), [
    "mint",
    "delegate",
    "project",
    "order",
  ]);
  // Collateral has to exist before it can be delegated.
  assert.ok(steps.findIndex((s) => s.kind === "mint") < steps.findIndex((s) => s.kind === "delegate"));
  assert.equal(steps[0].detail, "38 DEMO");
  assert.equal(describeApprovals(steps), "3 wallet approvals: 2 on Solana, 1 on MagicBlock.");
});

test("quote-only delegation still plans the projection wait", () => {
  const steps = planOrderSteps(conditions({ quoteToDelegate: 42n }));
  assert.deepEqual(steps.map((step) => step.kind), ["delegate", "project", "order"]);
});

test("replanning after a successful prerequisite drops it", () => {
  // The retry path: the mint landed, so the deficit is gone. Re-planning must
  // not ask the trader to lock collateral a second time.
  const before = planOrderSteps(conditions({ claimDeficit: 38, baseToDelegate: 100n }));
  const after = planOrderSteps(conditions({ claimDeficit: 0, baseToDelegate: 100n }));
  assert.ok(before.some((step) => step.kind === "mint"));
  assert.ok(!after.some((step) => step.kind === "mint"));
  assert.deepEqual(after.map((step) => step.kind), ["delegate", "project", "order"]);
});

test("a delegated balance that already landed leaves only the order", () => {
  const after = planOrderSteps(conditions({ claimDeficit: 0, baseToDelegate: 0n }));
  assert.deepEqual(after.map((step) => step.kind), ["order"]);
});

test("a halted flow is neither running nor complete", () => {
  const steps = planOrderSteps(conditions({ baseToDelegate: 5n }));
  let flow = beginFlow("buy", steps);
  flow = markDone(flow, 0, "sig-delegate");
  flow = markActive(flow, 1, "confirming");
  assert.equal(isRunning(flow), true);

  flow = markFailed(flow, 1, { kind: "projection-timeout" });
  assert.equal(isRunning(flow), false, "a halted flow must not block resubmission forever");
  assert.equal(isComplete(flow), false);
  assert.equal(flow.halted.at, 1);
  assert.equal(flow.halted.failure.kind, "projection-timeout");
  // The step that already landed keeps its signature, so a retry can show what
  // was already paid for.
  assert.equal(flow.states[0].signature, "sig-delegate");
});

test("a flow awaiting confirmation is not treated as in flight", () => {
  const steps = planOrderSteps(conditions({ claimDeficit: 1 }));
  let flow = beginFlow("sell", steps);
  flow = markDone(flow, 0, "sig-mint");
  flow = markAwaiting(flow, 1);
  assert.equal(isRunning(flow), false);
  assert.equal(isComplete(flow), false);
  assert.equal(flow.awaiting.at, 1);
});

test("every step done is complete", () => {
  const steps = planOrderSteps(conditions());
  let flow = beginFlow("sell", steps);
  flow = markDone(flow, 0, "sig");
  assert.equal(isComplete(flow), true);
  assert.equal(isRunning(flow), false);
});

test("approvals remaining counts only from the given step onward", () => {
  const steps = planOrderSteps(conditions({ claimDeficit: 5, baseToDelegate: 1n }));
  const flow = beginFlow("sell", steps);
  assert.equal(approvalsRemaining(flow, 0), 3);
  // Past the mint: delegation and the order remain.
  assert.equal(approvalsRemaining(flow, 1), 2);
  // Past the projection wait: only the order remains.
  assert.equal(approvalsRemaining(flow, 3), 1);
});

test("a wallet rejection is not reported as a failure", () => {
  const failure = classifyFailure(new Error("User rejected the request."), helpers);
  assert.equal(failure.kind, "cancelled");
});

test("an expired lifetime is distinguished from a real error", () => {
  const failure = classifyFailure(new Error("block height exceeded"), helpers);
  assert.equal(failure.kind, "expired");
});

test("a projection that never arrived is its own outcome", () => {
  // The delegation landed; only the mirror is late. Telling the user their
  // transaction failed here would be false, and would invite them to re-send
  // a delegation that already succeeded.
  const failure = classifyFailure(
    new Error("The delegated balance did not appear on MagicBlock in time."),
    helpers,
  );
  assert.equal(failure.kind, "projection-timeout");
});

test("rate limiting is transport, not program rejection", () => {
  for (const message of ["Server responded with 429", "fetch failed", "socket hang up"]) {
    assert.equal(classifyFailure(new Error(message), helpers).kind, "rpc", message);
  }
});

test("a program rejection is a simulation failure and carries its own words", () => {
  const failure = classifyFailure(
    new Error("Error Code: InsufficientCollateral. Error Number: 6003."),
    helpers,
  );
  assert.equal(failure.kind, "simulation");
  assert.match(failure.message, /InsufficientCollateral/);
});

test("an unrecognised error still produces something readable", () => {
  const failure = classifyFailure(new Error("something odd"), helpers);
  assert.equal(failure.kind, "error");
  assert.equal(failure.message, "something odd");
});

test("rejection is checked before anything else can claim the error", () => {
  // A rejection whose text also matches a transport pattern must still be a
  // cancellation: the user chose it, and styling it red is wrong.
  const failure = classifyFailure(new Error("User rejected after fetch failed"), helpers);
  assert.equal(failure.kind, "cancelled");
});
