import test from "node:test";
import assert from "node:assert/strict";

import { RETURN_PARAM, returnToParam, safeReturnTo, withReturnTo } from "../lib/return-to.ts";

test("a known app route is accepted", () => {
  assert.equal(safeReturnTo("/app"), "/app");
  assert.equal(safeReturnTo("/portfolio"), "/portfolio");
  assert.equal(
    safeReturnTo("/trade/markets?market=Abc123&view=n"),
    "/trade/markets?market=Abc123&view=n",
  );
});

test("nothing to return to is not an error", () => {
  assert.equal(safeReturnTo(null), null);
  assert.equal(safeReturnTo(undefined), null);
  assert.equal(safeReturnTo(""), null);
});

test("another origin is never a return destination", () => {
  // The protocol-relative form is the one a naive startsWith("/") check lets
  // straight through, and it is a full origin change in every browser.
  const hostile = [
    "//evil.example",
    "//evil.example/app",
    "https://evil.example",
    "http://evil.example/app",
    "javascript:alert(1)",
    "/" + String.fromCharCode(92) + "evil.example",
    String.fromCharCode(92, 92) + "evil.example",
    "/%09/evil.example",
  ];
  for (const value of hostile) {
    assert.equal(safeReturnTo(value), null, value);
  }
});

test("a route this app does not have is refused", () => {
  for (const unknown of ["/admin", "/app/../secret", "/trade", "/nope", "/mint/extra"]) {
    assert.equal(safeReturnTo(unknown), null, unknown);
  }
});

test("whitespace and control characters cannot be smuggled through", () => {
  for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x20, 0x7f]) {
    const value = "/app" + String.fromCharCode(code);
    assert.equal(safeReturnTo(value), null, "charCode " + code);
  }
});

test("a trailing slash still resolves to the same route", () => {
  assert.equal(safeReturnTo("/app/"), "/app");
});

test("a fragment is dropped rather than carried", () => {
  // Nothing in the app routes on a fragment, and carrying one through only
  // gives somewhere to hide payload.
  assert.equal(safeReturnTo("/app#anything"), "/app");
});

test("the round trip preserves the market the buyer was on", () => {
  const origin = returnToParam("/trade/markets", "?market=Xyz&view=n");
  const destination = withReturnTo("/mint", origin);
  assert.equal(
    destination,
    "/mint?" + RETURN_PARAM + "=" + encodeURIComponent("/trade/markets?market=Xyz&view=n"),
  );
  const back = new URL("https://x.test" + destination).searchParams.get(RETURN_PARAM);
  assert.equal(safeReturnTo(back), "/trade/markets?market=Xyz&view=n");
});

test("an unsafe origin simply does not get carried", () => {
  // The link still works; it just goes nowhere special afterwards.
  assert.equal(withReturnTo("/mint", "//evil.example"), "/mint");
});

test("returnToParam ignores an empty query", () => {
  assert.equal(returnToParam("/app", ""), "/app");
  assert.equal(returnToParam("/app", "?"), "/app");
});
