import type { SeriesView } from "./series-types";
import { ACTIVE_ISSUER } from "./issuers";
import { marketProfileForCollateral } from "./market-profile";
import { shortKey, statusOf } from "./format";
import type { MarketRowMetrics } from "./use-market-row";

export function marketAsset(view: SeriesView) {
  const mint = view.config.collateralMint.toBase58();
  const asset = ACTIVE_ISSUER.asset(mint) ?? marketProfileForCollateral(mint);
  return {
    mint,
    symbol: asset?.symbol ?? shortKey(mint),
    name: asset?.name ?? "Unverified collateral",
  };
}

export function marketStatus(view: SeriesView, now: number) {
  if (view.settlement || statusOf(view.config.status) === "Settled")
    return "Redeemable";
  if (view.config.maturityTs.toNumber() <= now) return "Awaiting settlement";
  return statusOf(view.config.status);
}

export function annualizedPremium(
  view: SeriesView,
  metrics: MarketRowMetrics | undefined,
  now: number,
) {
  const term = view.config.maturityTs.toNumber() - now;
  if (
    term <= 0 ||
    !metrics?.spot ||
    metrics.bestBid === null ||
    metrics.bookState !== "ready"
  )
    return null;
  // Indicative only: current book premium divided by token reference value.
  return (metrics.bestBid / metrics.spot) * ((365 * 86400) / term) * 100;
}
