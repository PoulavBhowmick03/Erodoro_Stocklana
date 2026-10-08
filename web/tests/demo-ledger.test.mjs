import test from "node:test";
import assert from "node:assert/strict";
import { buyStub, closeStub, initialLedger, markStub, moveDemoCash, moveStubPrice, redeemCapped, sellStub, setStubPrice, settleDue, stubLots, swapStub, updateOrder } from "../lib/demo/ledger.ts";

const now = 1791417600 + 3600;
const fresh = () => initialLedger(now);
const lot = (s) => stubLots(s, now).find((l) => l.symbol === "AAPL");

test("clickable underlying moves reprice open claims without changing balances or terms", () => {
  const s = buyStub(fresh(), lot(fresh()).id, 5, "buy", now).state;
  const position = s.positions[0];
  const value = markStub(position, s, now).value;
  const up = moveStubPrice(s, "AAPL", 5, now);
  const down = moveStubPrice(s, "AAPL", -5, now);
  assert.equal(up.prices.AAPL, 231);
  assert.equal(down.prices.AAPL, 209);
  assert.ok(markStub(position, up, now).value > value);
  assert.ok(markStub(position, down, now).value < value);
  assert.equal(up.cash, s.cash);
  assert.deepEqual(up.positions, s.positions);
  assert.deepEqual(up.stocks, s.stocks);
  assert.equal(up.prices.TSLA, s.prices.TSLA);
  assert.equal(stubLots(up, now).find((l) => l.id === position.lotId).strike, position.strike);
});

test("price buttons freeze an expired quote before changing the next scenario", () => {
  const s = buyStub(fresh(), lot(fresh()).id, 1, "rip", now).state;
  const p = s.positions[0];
  const expiry = p.expiryTs + 1;
  const next = moveStubPrice(s, "AAPL", 50, expiry);
  assert.equal(next.prices.AAPL, 330);
  assert.equal(next.settlements[p.lotId], 220);
  assert.equal(markStub(p, next, expiry).value, 0);
  assert.equal(closeStub(next, p.id, "redeem", expiry).cash, s.cash);
});

test("price controls reject malformed moves and retain a positive rounded price", () => {
  const s = fresh();
  for (const price of [-1, 0, Infinity, NaN]) assert.throws(() => setStubPrice(s, "AAPL", price, now));
  for (const pct of [-100, -101, Infinity, NaN]) assert.throws(() => moveStubPrice(s, "AAPL", pct, now));
  assert.throws(() => moveStubPrice(s, "UNKNOWN", 5, now));
  assert.equal(setStubPrice(s, "AAPL", 220.12345, now).prices.AAPL, 220.12);
  assert.equal(moveStubPrice(setStubPrice(s, "AAPL", 0.01, now), "AAPL", -5, now).prices.AAPL, 0.01);
});

test("offline buys debit cash, merge top-ups, consume inventory and forbid overdrafts", () => {
  let s = fresh();
  const l = lot(s);
  s = buyStub(s, l.id, 1, "rip", now).state;
  s = buyStub(s, l.id, 5, "buy", now).state;
  assert.equal(s.cash, 994);
  assert.equal(s.positions.length, 1);
  assert.equal(s.positions[0].fills.length, 2);
  assert.equal(s.consumed[l.id], 6);
  assert.equal(stubLots(s, now).find((x) => x.id === l.id).availableUsd, 244);
  assert.throws(() => buyStub({ ...s, cash: 0 }, l.id, 1, "rip", now), /Not enough/);
  assert.throws(() => buyStub(s, l.id, 245, "rip", now), /inventory/);
  for (const amount of [0, -1, NaN, Infinity]) assert.throws(() => buyStub(s, l.id, amount, "rip", now));
});

test("rejected, timed-out and disconnected demo actions cannot alter balances", () => {
  const s = fresh();
  for (const blocked of [{ ...s, failure: "reject" }, { ...s, failure: "network" }, { ...s, connected: false }]) {
    const before = JSON.stringify(blocked);
    assert.throws(() => buyStub(blocked, lot(s).id, 1, "rip", now));
    assert.throws(() => sellStub(blocked, lot(s).id, 1, 3, now));
    assert.equal(JSON.stringify(blocked), before);
  }
});

test("seller locks collateral, earns only on fill, and cannot fill the same order twice", () => {
  const s = sellStub(fresh(), lot(fresh()).id, 2, 3, now);
  assert.equal(s.cash, 1000);
  assert.equal(s.stocks.AAPL, 8);
  assert.equal(s.capped.length, 1);
  const filled = updateOrder(s, s.orders[0].id, "fill", now);
  assert.equal(filled.cash, 1006);
  assert.equal(filled.orders[0].status, "filled");
  assert.throws(() => updateOrder(filled, s.orders[0].id, "fill", now), /no longer open/);
  assert.throws(() => updateOrder(filled, s.orders[0].id, "cancel", now), /no longer open/);
});

test("cancelling and expired unfilled orders return stock exactly once", () => {
  const s = sellStub(fresh(), lot(fresh()).id, 2, 3, now);
  const cancelled = updateOrder(s, s.orders[0].id, "cancel", now);
  assert.equal(cancelled.stocks.AAPL, 10);
  assert.equal(cancelled.capped.length, 0);
  assert.equal(cancelled.cash, 1000);
  const expiry = s.orders[0].lot.expiryTs + 1;
  assert.throws(() => updateOrder(s, s.orders[0].id, "fill", expiry), /expired/);
  const expired = redeemCapped(s, s.capped[0].id, expiry);
  assert.equal(expired.stocks.AAPL, 10);
  assert.equal(expired.cash, 1000);
  assert.equal(expired.orders[0].status, "expired");
});

test("expiry fixes the settlement price for every claim and redemption cannot repeat", () => {
  let s = fresh();
  const l = lot(s);
  s = buyStub(s, l.id, 1, "rip", now).state;
  s = sellStub(s, l.id, 1, 3, now);
  s = updateOrder(s, s.orders[0].id, "fill", now);
  assert.throws(() => closeStub(s, s.positions[0].id, "redeem", now), /Wait until expiry/);
  const expiry = l.expiryTs + 1;
  s = settleDue({ ...s, prices: { ...s.prices, AAPL: 250 } }, expiry);
  const qty = s.positions[0].fills[0].qty;
  const id = s.positions[0].id;
  // Editing the next scenario's spot must not rewrite this series' payout.
  s = { ...s, prices: { ...s.prices, AAPL: 100 } };
  const cash = s.cash;
  s = closeStub(s, id, "redeem", expiry);
  assert.ok(Math.abs(s.cash - cash - (250 - l.strike) * qty) < 1e-6);
  const cashBeforeP = s.cash;
  s = redeemCapped(s, s.capped[0].id, expiry);
  assert.equal(s.cash - cashBeforeP, l.strike);
  assert.throws(() => closeStub(s, id, "redeem", expiry), /already closed/);
});

test("below-strike upside expires worthless and the seller retains full downside", () => {
  const l = lot(fresh());
  let s = buyStub(fresh(), l.id, 1, "rip", now).state;
  s = sellStub(s, l.id, 1, 3, now);
  s = updateOrder(s, s.orders[0].id, "fill", now);
  s = settleDue({ ...s, prices: { ...s.prices, AAPL: 100 } }, l.expiryTs + 1);
  const before = s.cash;
  s = closeStub(s, s.positions[0].id, "redeem", l.expiryTs + 1);
  assert.equal(s.cash, before);
  s = redeemCapped(s, s.capped[0].id, l.expiryTs + 1);
  assert.equal(s.cash, before + 100);
});

test("swap round trips and execution-session transfers conserve demo balances", () => {
  let s = swapStub(fresh(), "AAPL", 1, "buy");
  assert.equal(s.stocks.AAPL, 11);
  assert.equal(s.cash, 780);
  s = swapStub(s, "AAPL", 1, "sell");
  assert.equal(s.stocks.AAPL, 10);
  assert.equal(s.cash, 1000);
  s = moveDemoCash(s, "deposit", 10);
  assert.equal(s.cash + s.sessionCash, 1000);
  s = moveDemoCash(s, "withdraw", 10);
  assert.equal(s.cash, 1000);
  assert.equal(s.sessionCash, 0);
  assert.throws(() => moveDemoCash(s, "withdraw", 1), /exceeds/);
});
