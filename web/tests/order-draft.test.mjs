import test from "node:test";
import assert from "node:assert/strict";

import { orderDraftInternals } from "../lib/use-order-draft.ts";

const { key, parse } = orderDraftInternals;

test("drafts are scoped to a market and a leg", () => {
  assert.equal(key("MKT", "N"), "erodoro.draft.MKT.N");
  assert.notEqual(key("MKT", "N"), key("MKT", "P"));
  assert.notEqual(key("MKT", "N"), key("OTHER", "N"));
});

test("a well-formed draft round-trips", () => {
  const draft = { side: "buy", price: "12.5", size: "3" };
  assert.deepEqual(parse(JSON.stringify(draft)), draft);
});

test("nothing stored means nothing restored", () => {
  assert.equal(parse(null), null);
  assert.equal(parse(""), null);
});

test("malformed storage never reaches the ticket", () => {
  for (const raw of ["not json", "[]", "null", "42", '{"side":"buy"}']) {
    assert.equal(parse(raw), null, raw);
  }
});

test("an unrecognised side is refused", () => {
  assert.equal(parse('{"side":"short","price":"1","size":"1"}'), null);
});

test("values that are not plain decimals are refused", () => {
  // Storage is writable by anything running on the origin, so what comes back
  // is input, not state. A draft only ever holds what the numeric field could
  // itself have produced.
  for (const price of ["1e9", "-1", "0x10", "1,5", "Infinity", "<script>"]) {
    assert.equal(
      parse(JSON.stringify({ side: "buy", price, size: "1" })),
      null,
      price,
    );
  }
  for (const size of ["-2", "abc", "1 2"]) {
    assert.equal(
      parse(JSON.stringify({ side: "sell", price: "1", size })),
      null,
      size,
    );
  }
});

test("partial decimals a user can legitimately be mid-typing are kept", () => {
  assert.deepEqual(parse('{"side":"sell","price":"12.","size":""}'), {
    side: "sell",
    price: "12.",
    size: "",
  });
});

test("non-string numerics are refused rather than coerced", () => {
  assert.equal(parse('{"side":"buy","price":12,"size":"1"}'), null);
});
