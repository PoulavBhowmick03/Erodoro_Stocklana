import test from "node:test";
import assert from "node:assert/strict";

import { describeFill, fillDestination, fillMessage } from "../lib/fill-outcome.ts";

test("an order that did not cross is resting, not filled", () => {
  const outcome = describeFill({ requested: 10, restingAfter: 10 });
  assert.equal(outcome.kind, "rested");
  assert.match(fillMessage(outcome, "N", "sell"), /Resting on the book/);
  assert.match(fillDestination(outcome), /open orders/);
});

test("an order that fully crossed is filled", () => {
  const outcome = describeFill({ requested: 10, restingAfter: 0 });
  assert.equal(outcome.kind, "filled");
  assert.match(fillMessage(outcome, "N", "buy"), /Filled immediately.*bought 10 N/);
  assert.match(fillDestination(outcome), /in your portfolio/);
});

test("a partial fill reports both halves", () => {
  const outcome = describeFill({ requested: 10, restingAfter: 4 });
  assert.deepEqual(outcome, { kind: "partial", requested: 10, filled: 6, resting: 4 });
  const message = fillMessage(outcome, "N", "sell");
  assert.match(message, /6 N sold/);
  assert.match(message, /4 N still resting/);
  assert.match(fillDestination(outcome), /filled part.*portfolio.*rest.*open orders/);
});

test("floating-point dust does not become a permanent partial fill", () => {
  // A book that reports 9.999999999 against a request of 10 has filled it.
  const outcome = describeFill({ requested: 10, restingAfter: 10 - 1e-12 });
  assert.equal(outcome.kind, "rested");

  const nearlyGone = describeFill({ requested: 10, restingAfter: 1e-12 });
  assert.equal(nearlyGone.kind, "filled");
});

test("a book reporting more resting than was asked for cannot invent a negative fill", () => {
  // Another order of the signer's could be counted in; clamp rather than
  // report a nonsensical negative quantity.
  const outcome = describeFill({ requested: 5, restingAfter: 9 });
  assert.equal(outcome.kind, "rested");
});

test("a negative reading is treated as nothing resting", () => {
  const outcome = describeFill({ requested: 5, restingAfter: -1 });
  assert.equal(outcome.kind, "filled");
});

test("the verb follows the side the trader took", () => {
  const filled = describeFill({ requested: 2, restingAfter: 0 });
  assert.match(fillMessage(filled, "N", "buy"), /bought/);
  assert.match(fillMessage(filled, "N", "sell"), /sold/);
});
