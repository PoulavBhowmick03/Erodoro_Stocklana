import test from "node:test";
import assert from "node:assert/strict";

import { payoffExplanation, splitPayoff } from "../lib/payoff.ts";

const SPOT = 400;
const STRIKE = 500;

test("payoff values split at the strike", () => {
  assert.deepEqual(splitPayoff(250, STRIKE), { p: 250, n: 0 });
  assert.deepEqual(splitPayoff(420, STRIKE), { p: 420, n: 0 });
  assert.deepEqual(splitPayoff(600, STRIKE), { p: 500, n: 100 });
});

test("payoff explanation measures gains and falls from the entry price", () => {
  assert.equal(
    payoffExplanation(250, SPOT, STRIKE),
    "The collateral is $150 below its $400 entry price. P is worth $250 and N expires worthless.",
  );
  assert.equal(
    payoffExplanation(420, SPOT, STRIKE),
    "The collateral is $20 above its $400 entry price but below the $500 strike. P is worth $420 and N expires worthless.",
  );
  assert.equal(
    payoffExplanation(600, SPOT, STRIKE),
    "P is capped at $500. N receives the remaining $100 of value.",
  );
});

test("payoff explanation handles entry and strike boundaries", () => {
  assert.equal(
    payoffExplanation(400, SPOT, STRIKE),
    "The collateral is unchanged from its $400 entry price and below the $500 strike. P is worth $400 and N expires worthless.",
  );
  assert.equal(
    payoffExplanation(500, SPOT, STRIKE),
    "The collateral finishes at the $500 strike. P is worth $500 and N expires worthless.",
  );
});
