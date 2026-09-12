import assert from "node:assert/strict";
import test from "node:test";

import { ordersBySide } from "../lib/portfolio-orders.ts";

test("book orders are classified by the side they came from", () => {
  const bidA = { id: "bid-a" };
  const bidB = { id: "bid-b" };
  const ask = { id: "ask" };

  assert.deepEqual([...ordersBySide([bidA, bidB], [ask])], [
    { order: bidA, side: "buy" },
    { order: bidB, side: "buy" },
    { order: ask, side: "sell" },
  ]);
});

test("each side is consumed once without membership lookups", () => {
  let bidReads = 0;
  let askReads = 0;
  const bids = {
    *[Symbol.iterator]() {
      bidReads += 1;
      yield "bid";
    },
  };
  const asks = {
    *[Symbol.iterator]() {
      askReads += 1;
      yield "ask";
    },
  };

  assert.deepEqual([...ordersBySide(bids, asks)], [
    { order: "bid", side: "buy" },
    { order: "ask", side: "sell" },
  ]);
  assert.equal(bidReads, 1);
  assert.equal(askReads, 1);
});
