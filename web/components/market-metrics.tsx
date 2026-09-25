"use client";
import { useEffect } from "react";
import type { SeriesView } from "@/lib/series-types";
import {
  useMarketRowMetrics,
  type MarketRowMetrics,
} from "@/lib/use-market-row";
import { marketProfileForCollateral } from "@/lib/market-profile";
import { useMagicBlockPrice } from "@/lib/use-magicblock-price";

/** One hook instance per market, also used for sorting/filtering its display row. */
export function MarketMetrics({
  view,
  onMetrics,
}: {
  view: SeriesView;
  onMetrics: (id: string, metrics: MarketRowMetrics) => void;
}) {
  const profile = marketProfileForCollateral(
    view.config.collateralMint.toBase58(),
  );
  const realtime = useMagicBlockPrice(profile?.realtime);
  const metrics = useMarketRowMetrics(
    view,
    "seller",
    realtime.state.kind === "ready" ? realtime.state.price : null,
  );
  const {
    spot,
    distancePct,
    bestBid,
    bestAsk,
    bestBidSize,
    premiumPct,
    quoteState,
    bookState,
  } = metrics;
  const id = view.address.toBase58();
  useEffect(() => {
    onMetrics(id, {
      spot,
      distancePct,
      bestBid,
      bestAsk,
      bestBidSize,
      premiumPct,
      quoteState,
      bookState,
      volume24h: null,
    });
  }, [
    id,
    spot,
    distancePct,
    bestBid,
    bestAsk,
    bestBidSize,
    premiumPct,
    quoteState,
    bookState,
    onMetrics,
  ]);
  return null;
}
