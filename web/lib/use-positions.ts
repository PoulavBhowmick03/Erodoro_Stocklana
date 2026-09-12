"use client";

import { useMemo } from "react";
import { useSeries } from "./use-series";
import { useTokenBalances, type Holding } from "./use-token-balances";
import type { SeriesView } from "./series-types";

/**
 * `0n` is a syntax error at this project's ES2017 target, which is why
 * `use-token-balances.ts` reaches for the constructor too.
 */
const ZERO = BigInt(0);

/** What the connected key holds in one series. */
export type Position = {
  view: SeriesView;
  /** Raw P and N balances, before decimals. */
  p: bigint;
  n: bigint;
  /** Decimals both claim mints carry — they copy the collateral's. */
  decimals: number;
  /**
   * What this position can be redeemed for right now, in raw collateral, or
   * `null` while the series is still open.
   *
   * Pro-rata against the pools the settlement recorded, which is how the
   * program pays out: each side's pool divided by the supply that existed at
   * settlement. It is an estimate of the *entitlement*, not a promise -- if the
   * vault came up short, `shortfall_observed` is set and every redeemer takes
   * the same haircut.
   */
  claimable: bigint | null;
  /** Whether that entitlement is subject to a haircut. */
  shortfall: boolean;
};

/** Raw balance of `mint` in the holdings list, or zero. */
function balanceOf(holdings: Holding[], mint: string): bigint {
  const h = holdings.find((x) => x.mint === mint);
  return h ? h.raw : ZERO;
}

/**
 * Every canonical series the connected key has a stake in.
 *
 * Built by joining the registry against the wallet's token accounts rather than
 * by scanning: the series list is already loaded for the markets table, and the
 * balances hook already reads both token programs in two requests. Nothing here
 * adds a round trip.
 */
export function usePositions() {
  const { state: seriesState, reload: reloadSeries } = useSeries();
  const { state: balanceState, reload: reloadBalances } = useTokenBalances();

  const positions = useMemo<Position[]>(() => {
    if (seriesState.kind !== "ready" || balanceState.kind !== "ready") return [];
    const holdings = balanceState.holdings;

    const out: Position[] = [];
    for (const view of seriesState.series) {
      const p = balanceOf(holdings, view.config.pMint.toBase58());
      const n = balanceOf(holdings, view.config.nMint.toBase58());
      if (p === ZERO && n === ZERO) continue;

      let claimable: bigint | null = null;
      const s = view.settlement;
      if (s) {
        const pSupply = BigInt(s.pSupplyAtSettlement.toString());
        const nSupply = BigInt(s.nSupplyAtSettlement.toString());
        const pPool = BigInt(s.pPool.toString());
        const nPool = BigInt(s.nPool.toString());
        // Guard the divisors: a side with no supply at settlement has no
        // claimants, and its pool is swept as dust rather than divided by zero.
        const fromP = pSupply > ZERO ? (p * pPool) / pSupply : ZERO;
        const fromN = nSupply > ZERO ? (n * nPool) / nSupply : ZERO;
        claimable = fromP + fromN;
      }

      out.push({
        view,
        p,
        n,
        decimals: view.config.collateralDecimals,
        claimable,
        shortfall: Boolean(s?.shortfallObserved),
      });
    }

    // Soonest maturity first: the ones needing attention are the ones about to
    // stop being tradeable.
    return out.sort(
      (a, b) => a.view.config.maturityTs.toNumber() - b.view.config.maturityTs.toNumber(),
    );
  }, [seriesState, balanceState]);

  const loading = seriesState.kind === "loading" || balanceState.kind === "loading";

  return {
    positions,
    loading,
    reload: () => {
      void reloadSeries();
      void reloadBalances();
    },
  };
}
