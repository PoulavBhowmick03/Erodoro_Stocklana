/**
 * Rips, as data.
 *
 * A Rip is a $1 purchase of real upside-claim (N) inventory, drawn at random
 * from what is currently offered. Everything here is pure so the rules a user
 * can feel -- what a Rip costs, what it is worth, how it is described -- are
 * testable without a chain or a browser.
 *
 * Only N is ever ripped. N pays the underlying's value above the strike at
 * expiry, which is an honest "UP". P keeps the full downside and caps the
 * upside, so it is not a "DOWN" bet and is never offered as one.
 */

export const RIP_PRICE = 1;
export const BUY_MORE_PRICE = 5;

/** Where a lot came from. Demo lots never touch a wallet. */
export type RipSource = "live" | "demo";

/** One kind of position currently offered in the pool. */
export type PoolLot = {
  /** Stable across refreshes: a series address, or a demo lot key. */
  id: string;
  source: RipSource;
  symbol: string;
  name: string;
  /** Exposure begins above this underlying price. */
  strike: number;
  /** Underlying price right now, when known. */
  spot: number | null;
  expiryTs: number;
  /** Price of one claim at the best offer. */
  askPrice: number;
  /** Dollar value of everything currently offered for this lot. */
  availableUsd: number;
  /** On-chain series address, for live lots. */
  series?: string;
};

/**
 * One fill against a position: a Rip, a deliberate top-up, or claims the chain
 * says this wallet holds that this browser never recorded buying (bought on
 * another device, or through Pro). Untracked fills carry no cost: what was
 * paid for them is not knowable here, so they are kept out of gain/loss.
 */
export type RipFill = {
  kind: "rip" | "buy" | "untracked";
  qty: number;
  paid: number;
  at: number;
  signature?: string;
};

/** What a user owns. Repeat Rips and top-ups of the same lot merge here. */
export type RipPosition = {
  id: string;
  lotId: string;
  source: RipSource;
  symbol: string;
  name: string;
  strike: number;
  /** Underlying price when first pulled, to describe the move it needed. */
  spotAtRip: number | null;
  expiryTs: number;
  /** Whole days from the first Rip to expiry: the "30D" on the card. */
  termDays: number;
  series?: string;
  fills: RipFill[];
};

export const totalQty = (p: RipPosition) => p.fills.reduce((s, f) => s + f.qty, 0);
/** Claims whose cost is known: everything except untracked fills. */
export const trackedQty = (p: RipPosition) =>
  p.fills.reduce((s, f) => s + (f.kind === "untracked" ? 0 : f.qty), 0);
export const untrackedQty = (p: RipPosition) => totalQty(p) - trackedQty(p);
export const ripCount = (p: RipPosition) => p.fills.filter((f) => f.kind === "rip").length;
export const totalPaid = (p: RipPosition) => p.fills.reduce((s, f) => s + f.paid, 0);
export const firstAt = (p: RipPosition) => Math.min(...p.fills.map((f) => f.at));

/** How far the underlying must rise before the claim pays, in percent. */
export function movePct(strike: number, spot: number | null): number | null {
  if (!spot || spot <= 0) return null;
  return ((strike - spot) / spot) * 100;
}

/** "+5%", rounded the way a person would say it. */
export function moveLabel(pct: number | null): string {
  if (pct === null) return "";
  const r = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 2) / 2;
  if (r === 0) return "AT";
  return `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

export function termDays(fromSecs: number, expiryTs: number) {
  return Math.max(0, Math.round((expiryTs - fromSecs) / 86_400));
}

/** Remaining time, coarse: "17d left", "5h left", "Expired". */
export function timeLeft(expiryTs: number, nowSecs: number) {
  const s = expiryTs - nowSecs;
  if (s <= 0) return "Expired";
  const d = Math.floor(s / 86_400);
  if (d >= 1) return `${d}d left`;
  const h = Math.floor(s / 3_600);
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(s / 60))}m left`;
}

/** Value of a claim at expiry for an underlying price. Never below zero. */
export function upsideAtExpiry(price: number, strike: number) {
  return Math.max(0, price - strike);
}

/**
 * Pick a lot at random, weighted by the dollars on offer.
 *
 * Weighting by inventory is what makes the pull honest: a Rip consumes real
 * offers, so a lot with more on offer is proportionally more likely to be the
 * one consumed. Lots that cannot fill a whole Rip are excluded.
 */
export function pickLot(lots: PoolLot[], random: number, budget = RIP_PRICE): PoolLot | null {
  const eligible = lots.filter((l) => l.availableUsd >= budget * 0.98 && l.askPrice > 0);
  const total = eligible.reduce((s, l) => s + l.availableUsd, 0);
  if (total <= 0) return null;
  let point = Math.min(Math.max(random, 0), 0.999999) * total;
  for (const lot of eligible) {
    point -= lot.availableUsd;
    if (point < 0) return lot;
  }
  return eligible[eligible.length - 1];
}

export type AskLevel = { price: number; size: number };

/**
 * Walk the offers best-first and spend up to `budget`.
 *
 * Returns the quantity bought, what it cost, and the worst price touched --
 * the limit for an immediate-or-cancel order, so the order can never pay more
 * than the walk did and never rests on the book afterwards.
 */
export function fillFromAsks(asks: AskLevel[], budget: number, qtyStep = 1e-6) {
  let qty = 0;
  let cost = 0;
  let limit = 0;
  for (const level of [...asks].sort((a, b) => a.price - b.price)) {
    if (level.price <= 0 || level.size <= 0) continue;
    const remaining = budget - cost;
    if (remaining <= level.price * qtyStep) break;
    // The epsilon keeps float division (0.1 / 0.5 / 1e-6 = 199999.99…) from
    // dropping a whole step the budget can afford.
    const take = Math.min(level.size, Math.floor(remaining / level.price / qtyStep + 1e-9) * qtyStep);
    if (take <= 0) break;
    qty += take;
    cost += take * level.price;
    limit = level.price;
  }
  return { qty, cost, limit };
}

/** Add a fill to the matching position, or open one. */
export function addFill(
  positions: RipPosition[],
  lot: PoolLot,
  fill: RipFill,
): { positions: RipPosition[]; position: RipPosition } {
  const id = `${lot.source}:${lot.id}`;
  const existing = positions.find((p) => p.id === id);
  if (existing) {
    const position = { ...existing, fills: [...existing.fills, fill] };
    return { positions: positions.map((p) => (p.id === id ? position : p)), position };
  }
  const nowSecs = Math.floor(fill.at / 1000);
  const position: RipPosition = {
    id,
    lotId: lot.id,
    source: lot.source,
    symbol: lot.symbol,
    name: lot.name,
    strike: lot.strike,
    spotAtRip: lot.spot,
    expiryTs: lot.expiryTs,
    termDays: termDays(nowSecs, lot.expiryTs),
    series: lot.series,
    fills: [fill],
  };
  return { positions: [position, ...positions], position };
}

/** What the chain says a wallet holds in one live market. */
export type Holding = {
  series: string;
  qty: number;
  symbol: string;
  name: string;
  strike: number;
  expiryTs: number;
  spot: number | null;
};

/**
 * Bring recorded positions in line with the chain.
 *
 * Records live in one browser; the claims live on chain. Anything held beyond
 * what this browser recorded is added as an untracked fill (or a whole
 * untracked position), so a Rip made elsewhere is never invisible. Never
 * written back to storage: it is recomputed from the chain every time.
 */
export function reconcile(positions: RipPosition[], holdings: Holding[], nowSecs: number): RipPosition[] {
  const out = [...positions];
  for (const h of holdings) {
    if (h.qty <= 1e-9) continue;
    const id = `live:${h.series}`;
    const index = out.findIndex((p) => p.id === id);
    const recorded = index >= 0 ? trackedQty(out[index]) : 0;
    const extra = h.qty - recorded;
    if (extra <= 1e-9) continue;
    const fill: RipFill = { kind: "untracked", qty: extra, paid: 0, at: 0 };
    if (index >= 0) {
      out[index] = { ...out[index], fills: [...out[index].fills, fill] };
    } else {
      out.push({
        id,
        lotId: h.series,
        source: "live",
        symbol: h.symbol,
        name: h.name,
        strike: h.strike,
        spotAtRip: h.spot,
        expiryTs: h.expiryTs,
        termDays: termDays(nowSecs, h.expiryTs),
        series: h.series,
        fills: [fill],
      });
    }
  }
  return out;
}

/** The Level 2 sentence. */
export function explainPosition(p: Pick<RipPosition, "name" | "strike" | "expiryTs">) {
  return `Pays based on ${p.name} gains above ${usd(p.strike)} until ${shortDate(p.expiryTs)}.`;
}

export function usd(n: number, digits?: number) {
  const abs = Math.abs(n);
  const d = digits ?? (abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 2 : 6);
  return `${n < 0 ? "−" : ""}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: d === 0 ? 0 : Math.min(d, 2),
    maximumFractionDigits: d,
  })}`;
}

export function pctChange(value: number, paid: number) {
  if (paid <= 0) return 0;
  return ((value - paid) / paid) * 100;
}

export function signedPct(pct: number) {
  const r = Math.round(pct);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
}

export function shortDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
