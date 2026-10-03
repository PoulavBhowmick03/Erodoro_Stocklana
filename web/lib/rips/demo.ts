/**
 * The demo pool: simulated crypto-linked upside claims on test networks.
 *
 * Nothing here is a market. Prices are a deterministic function of time so
 * every tab agrees and cards visibly move; claim values come from a textbook
 * Black–Scholes call so a demo Rip starts near what was paid and drifts with
 * the simulated price, which is the behaviour a real position has.
 *
 * Deliberately crypto-only. Devnet has no stock collateral, and simulated
 * stock prices beside a "real positions" product would read as a claim about
 * real stocks. The UI labels every demo surface as simulated.
 */

import type { PoolLot } from "./model";

type DemoAsset = { symbol: string; name: string; base: number; vol: number; phase: number };

export const DEMO_ASSETS: readonly DemoAsset[] = [
  { symbol: "SOL", name: "Solana", base: 182, vol: 0.75, phase: 0.3 },
  { symbol: "BTC", name: "Bitcoin", base: 96_000, vol: 0.5, phase: 1.7 },
  { symbol: "ETH", name: "Ethereum", base: 3_500, vol: 0.65, phase: 2.9 },
  { symbol: "JUP", name: "Jupiter", base: 0.92, vol: 1.0, phase: 4.1 },
  { symbol: "JTO", name: "Jito", base: 2.6, vol: 1.0, phase: 5.3 },
  { symbol: "BONK", name: "Bonk", base: 0.000024, vol: 1.2, phase: 0.9 },
];

const TERMS = [7, 14, 30];
const MOVES = [0.03, 0.05, 0.1];
const DAY = 86_400;

/**
 * Simulated price at a unix time. A slow swing over days plus a quicker wiggle
 * over minutes, scaled by the asset's volatility. Smooth, bounded, shared.
 */
export function demoSpot(symbol: string, tSecs: number): number {
  const a = DEMO_ASSETS.find((x) => x.symbol === symbol);
  if (!a) return 0;
  const days = tSecs / DAY;
  const slow = 0.22 * Math.sin(days / 3.1 + a.phase) + 0.12 * Math.sin(days / 1.3 + a.phase * 2);
  const fast = 0.012 * Math.sin(tSecs / 47 + a.phase) + 0.008 * Math.sin(tSecs / 13 + a.phase * 3);
  return a.base * Math.exp(a.vol * (slow * 0.5 + fast));
}

function normCdf(x: number) {
  // Abramowitz–Stegun 7.1.26; plenty for a simulation.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Value of one upside claim before expiry; intrinsic at and after it. */
export function demoClaimValue(spot: number, strike: number, yearsLeft: number, vol: number) {
  if (yearsLeft <= 0 || vol <= 0) return Math.max(0, spot - strike);
  const sd = vol * Math.sqrt(yearsLeft);
  const d1 = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  return spot * normCdf(d1) - strike * normCdf(d1 - sd);
}

export function demoVol(symbol: string) {
  return DEMO_ASSETS.find((a) => a.symbol === symbol)?.vol ?? 0.8;
}

/** Mark one demo claim now. */
export function demoMark(symbol: string, strike: number, expiryTs: number, nowSecs: number) {
  const spot = demoSpot(symbol, nowSecs);
  return {
    spot,
    value: demoClaimValue(spot, strike, (expiryTs - nowSecs) / (365 * DAY), demoVol(symbol)),
  };
}

function roundStrike(x: number) {
  // Three significant figures, without float residue like 0.0000291999….
  return Number(x.toPrecision(3));
}

/** Cheap stable hash, for per-day inventory that differs by lot. */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/**
 * Today's demo pool. Lots are listed at the start of each UTC day, so the pool
 * genuinely changes from one day to the next -- a reason to come back that is
 * about inventory, not a streak.
 */
export function demoLots(nowSecs: number, consumedUsd: Record<string, number> = {}): PoolLot[] {
  const day = Math.floor(nowSecs / DAY) * DAY;
  const lots: PoolLot[] = [];
  for (const a of DEMO_ASSETS) {
    const listedSpot = demoSpot(a.symbol, day);
    // Two of the three terms per asset per day, so the mix rotates.
    const terms = TERMS.filter((_, i) => hash(`${a.symbol}${day}${i}`) > 0.3);
    for (const term of terms) {
      const move = MOVES[Math.floor(hash(`${a.symbol}${day}${term}m`) * MOVES.length)];
      const strike = roundStrike(listedSpot * (1 + move));
      const expiryTs = day + term * DAY;
      const id = `${a.symbol}-${term}d-${strike}-${day}`;
      const { spot, value } = demoMark(a.symbol, strike, expiryTs, nowSecs);
      const listed = 40 + Math.round(hash(id) * 160);
      const availableUsd = Math.max(0, listed - (consumedUsd[id] ?? 0));
      if (value <= 0) continue;
      lots.push({
        id,
        source: "demo",
        symbol: a.symbol,
        name: a.name,
        strike,
        spot,
        expiryTs,
        askPrice: value,
        availableUsd,
      });
    }
  }
  return lots;
}
