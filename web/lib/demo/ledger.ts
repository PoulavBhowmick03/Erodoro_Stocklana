import { STUB_ASSETS } from "../demo-config.ts";
import { addFill, totalQty, type PoolLot, type RipFill, type RipPosition } from "../rips/model.ts";
import { demoClaimValue } from "../rips/demo.ts";

export type DemoOrder = {
  id: string; lot: PoolLot; qty: number; premium: number;
  status: "open" | "filled" | "cancelled" | "expired";
};
export type CappedPosition = { id: string; lotId: string; symbol: string; qty: number; strike: number; expiryTs: number };
export type DemoLedger = {
  connected: boolean;
  cash: number;
  sessionCash: number;
  stocks: Record<string, number>;
  prices: Record<string, number>;
  positions: RipPosition[];
  capped: CappedPosition[];
  orders: DemoOrder[];
  consumed: Record<string, number>;
  settlements: Record<string, number>;
  activity: { id: string; text: string; at: number }[];
  offset: number;
  anchor: number;
  failure: "none" | "reject" | "network";
};

export function initialLedger(anchor = Math.floor(Date.now() / 1000)): DemoLedger {
  return {
    connected: true, cash: 1000, sessionCash: 0,
    stocks: Object.fromEntries(STUB_ASSETS.map((a) => [a.symbol, 10])),
    prices: Object.fromEntries(STUB_ASSETS.map((a) => [a.symbol, a.base])),
    positions: [], capped: [], orders: [], consumed: {}, settlements: {}, activity: [], offset: 0,
    anchor: Math.floor(anchor / 86400) * 86400, failure: "none",
  };
}

const money = (n: number) => Math.round(n * 1e6) / 1e6;
const positive = (n: number) => Number.isFinite(n) && n > 0;

/** Scenario controls change the underlying quote, never a position's terms. */
export function setStubPrice(state: DemoLedger, symbol: string, price: number, now: number) {
  if (!STUB_ASSETS.some((a) => a.symbol === symbol) || !positive(price)) {
    throw new Error("Choose a demo stock and a positive finite price.");
  }
  const rounded = Math.max(0.01, Math.round(price * 100) / 100);
  if (!Number.isFinite(rounded)) throw new Error("The demo stock price is too large.");
  return { ...settleDue(state, now), prices: { ...state.prices, [symbol]: rounded } };
}

export function moveStubPrice(state: DemoLedger, symbol: string, percent: number, now: number) {
  if (!Number.isFinite(percent) || percent <= -100) throw new Error("Enter a valid percentage move above -100%.");
  return setStubPrice(state, symbol, state.prices[symbol] * (1 + percent / 100), now);
}

function check(state: DemoLedger) {
  if (!state.connected) throw new Error("Connect the demo wallet to continue.");
  if (state.failure === "reject") throw new Error("Demo approval rejected. Your balances have not changed.");
  if (state.failure === "network") throw new Error("Simulated network timeout. Turn off the failure and retry.");
}
function event(state: DemoLedger, text: string): DemoLedger {
  return { ...state, activity: [{ id: crypto.randomUUID(), text, at: Date.now() }, ...state.activity].slice(0, 100) };
}

/** Once expiry has been observed, every claim uses the same fixed quote. */
export function settleDue(state: DemoLedger, now: number): DemoLedger {
  const due = [...state.positions, ...state.capped].filter((p) => p.expiryTs <= now && state.settlements[p.lotId] === undefined);
  if (!due.length) return state;
  return { ...state, settlements: { ...state.settlements, ...Object.fromEntries(due.map((p) => [p.lotId, state.prices[p.symbol]])) } };
}

/** Stable inventory survives midnight and reloads. Only reset starts new terms. */
export function stubLots(state: DemoLedger, now: number): PoolLot[] {
  return STUB_ASSETS.flatMap((a) => [7, 14, 30].map((days) => {
    const strike = Number((a.base * 1.05).toFixed(2));
    const expiryTs = state.anchor + days * 86400;
    const id = `stub-${a.symbol}-${days}-${state.anchor}`;
    const spot = state.prices[a.symbol];
    const value = demoClaimValue(spot, strike, (expiryTs - now) / (365 * 86400), a.vol);
    return {
      id, source: "demo" as const, symbol: a.symbol, name: a.name, strike, spot, expiryTs,
      askPrice: Math.max(0.01, money(value)), availableUsd: Math.max(0, 250 - (state.consumed[id] ?? 0)),
    };
  })).filter((l) => l.expiryTs > now);
}

export function markStub(p: RipPosition, state: DemoLedger, now: number) {
  const asset = STUB_ASSETS.find((a) => a.symbol === p.symbol)!;
  const spot = state.settlements[p.lotId] ?? state.prices[p.symbol];
  return { spot, value: demoClaimValue(spot, p.strike, (p.expiryTs - now) / (365 * 86400), asset.vol) * totalQty(p), marked: "model" as const };
}

export function buyStub(state: DemoLedger, lotId: string, budget: number, kind: RipFill["kind"], now: number) {
  check(state);
  const lot = stubLots(state, now).find((l) => l.id === lotId);
  if (!lot || !positive(budget)) throw new Error("This position is unavailable.");
  if (budget > lot.availableUsd) throw new Error("There is not enough inventory for this purchase.");
  if (budget > state.cash) throw new Error("Not enough demo USDC. Top up from Demo controls.");
  const fill: RipFill = { kind, qty: budget / lot.askPrice, paid: budget, at: Date.now() };
  const { positions, position } = addFill(state.positions, lot, fill);
  const next = event({ ...state, cash: money(state.cash - budget), positions,
    consumed: { ...state.consumed, [lot.id]: money((state.consumed[lot.id] ?? 0) + budget) },
  }, `Bought ${lot.symbol} upside for $${budget.toFixed(2)} demo USDC`);
  return { state: next, position, fill };
}

/** Lock stock now; premiums arrive only when a simulated counterparty fills. */
export function sellStub(state: DemoLedger, lotId: string, qty: number, premium: number, now: number) {
  check(state);
  const lot = stubLots(state, now).find((l) => l.id === lotId);
  if (!lot || !positive(qty) || !positive(premium)) throw new Error("Enter valid terms, quantity and premium.");
  if (qty > state.stocks[lot.symbol]) throw new Error("Quantity exceeds your demo stock balance.");
  const id = crypto.randomUUID();
  return event({ ...state,
    stocks: { ...state.stocks, [lot.symbol]: state.stocks[lot.symbol] - qty },
    orders: [...state.orders, { id, lot, qty, premium, status: "open" }],
    capped: [...state.capped, { id, lotId: lot.id, symbol: lot.symbol, qty, strike: lot.strike, expiryTs: lot.expiryTs }],
  }, `Locked ${qty} ${lot.symbol}; upside sell order placed`);
}

export function updateOrder(state: DemoLedger, id: string, action: "fill" | "cancel", now: number) {
  check(state);
  const order = state.orders.find((o) => o.id === id && o.status === "open");
  if (!order) throw new Error("This order is no longer open.");
  if (action === "fill" && order.lot.expiryTs <= now) throw new Error("This order has expired. Cancel it to unlock collateral.");
  if (action === "fill") return event({ ...state,
    cash: money(state.cash + order.qty * order.premium),
    orders: state.orders.map((o) => o.id === id ? { ...o, status: "filled" } : o),
  }, `Counterparty filled ${order.lot.symbol}; received $${(order.qty * order.premium).toFixed(2)} premium`);
  return event({ ...state,
    stocks: { ...state.stocks, [order.lot.symbol]: state.stocks[order.lot.symbol] + order.qty },
    capped: state.capped.filter((p) => p.id !== id),
    orders: state.orders.map((o) => o.id === id ? { ...o, status: "cancelled" } : o),
  }, `Cancelled ${order.lot.symbol} order; collateral returned`);
}

export function closeStub(state: DemoLedger, id: string, action: "sell" | "redeem", now: number) {
  check(state);
  state = settleDue(state, now);
  const p = state.positions.find((p) => p.id === id);
  if (!p) throw new Error("Position is already closed.");
  if (action === "redeem" && p.expiryTs > now) throw new Error("Wait until expiry before redeeming.");
  if (action === "sell" && p.expiryTs <= now) throw new Error("This position has expired. Redeem it instead.");
  const value = action === "redeem"
    ? Math.max(0, state.settlements[p.lotId] - p.strike) * totalQty(p)
    : markStub(p, state, now).value * 0.98;
  return event({ ...state, cash: money(state.cash + value), positions: state.positions.filter((x) => x.id !== id) },
    `${action === "redeem" ? "Redeemed" : "Sold"} ${p.symbol} upside for $${value.toFixed(2)} demo USDC`);
}

export function redeemCapped(state: DemoLedger, id: string, now: number) {
  check(state);
  state = settleDue(state, now);
  const p = state.capped.find((p) => p.id === id);
  if (!p || p.expiryTs > now) throw new Error("This capped claim is not ready to redeem.");
  const order = state.orders.find((o) => o.id === id);
  const unfilled = order?.status === "open";
  const value = unfilled ? 0 : Math.min(state.settlements[p.lotId], p.strike) * p.qty;
  return event({ ...state, cash: money(state.cash + value),
    stocks: unfilled ? { ...state.stocks, [p.symbol]: state.stocks[p.symbol] + p.qty } : state.stocks,
    capped: state.capped.filter((x) => x.id !== id),
    orders: state.orders.map((o) => o.id === id && o.status === "open" ? { ...o, status: "expired" } : o),
  }, unfilled ? `Expired unfilled ${p.symbol} order; stock returned` : `Redeemed capped ${p.symbol} for $${value.toFixed(2)} demo USDC`);
}

export function swapStub(state: DemoLedger, symbol: string, qty: number, side: "buy" | "sell") {
  check(state);
  if (!STUB_ASSETS.some((a) => a.symbol === symbol) || !positive(qty)) throw new Error("Enter a valid stock quantity.");
  const value = money(qty * state.prices[symbol]);
  if (side === "buy" && value > state.cash) throw new Error("Not enough demo USDC.");
  if (side === "sell" && qty > state.stocks[symbol]) throw new Error("Not enough demo stock.");
  return event({ ...state, cash: money(state.cash + (side === "buy" ? -value : value)),
    stocks: { ...state.stocks, [symbol]: state.stocks[symbol] + (side === "buy" ? qty : -qty) },
  }, `${side === "buy" ? "Bought" : "Sold"} ${qty} ${symbol} stock for $${value.toFixed(2)} demo USDC`);
}

export function moveDemoCash(state: DemoLedger, direction: "deposit" | "withdraw", amount: number) {
  check(state);
  if (!positive(amount)) throw new Error("Enter a valid amount.");
  const from = direction === "deposit" ? state.cash : state.sessionCash;
  if (amount > from) throw new Error("Amount exceeds available demo balance.");
  const delta = direction === "deposit" ? amount : -amount;
  return event({ ...state, cash: money(state.cash - delta), sessionCash: money(state.sessionCash + delta) },
    `${direction === "deposit" ? "Deposited" : "Returned"} $${amount} demo USDC ${direction === "deposit" ? "to session" : "to wallet"}`);
}
