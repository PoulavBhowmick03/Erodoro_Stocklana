"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import type { Role } from "@/components/role-toggle";
import { QUOTE_MINT } from "./deployment";
import { fromRaw } from "./format";
import {
  MANIFEST_PROGRAM_ID,
  loadManifestMarket,
  manifestMarketPda,
} from "./manifest";
import { aggregateBookSide } from "./order-book-levels";
import { nMintPda } from "./pdas";
import { useBookLocation, useEphemeral } from "./rollup";
import type { SeriesView } from "./series-types";
import { useFeedId } from "./use-feed-id";
import { useOracleQuote } from "./use-oracle";
import { marketProfileForCollateral } from "./market-profile";

export type MarketRowMetrics = {
  spot: number | null;
  distancePct: number | null;
  bestBid: number | null;
  bestBidSize: number | null;
  bookState: "loading" | "ready" | "unavailable";
  bestAsk: number | null;
  premiumPct: number | null;
  volume24h: null;
  quoteState: "loading" | "ready" | "unavailable";
};

/**
 * Decision data for one discovery row.
 *
 * Spot comes from the same Pyth source settlement uses. Bid and ask come from
 * the live MagicBlock copy of the Manifest N market when delegated, otherwise
 * from Solana. Manifest stores the current book but not a durable 24-hour fill
 * aggregate, so volume deliberately remains null until an indexer exists.
 */
export function useMarketRowMetrics(
  view: SeriesView,
  intent: Role,
  realtimeSpot?: number | null,
): MarketRowMetrics {
  const { connection: l1 } = useConnection();
  const { connection: rollup } = useEphemeral();
  const profile = marketProfileForCollateral(
    view.config.collateralMint.toBase58(),
  );
  const feedId = useFeedId(profile ? undefined : view.config.oracleAdapter);
  const oracle = useOracleQuote(feedId);
  const marketAddress = useMemo(
    () =>
      manifestMarketPda(
        nMintPda(view.address),
        QUOTE_MINT,
        MANIFEST_PROGRAM_ID,
      ),
    [view.address],
  );
  const { location } = useBookLocation(marketAddress, MANIFEST_PROGRAM_ID);
  const [bookState, setBookState] =
    useState<MarketRowMetrics["bookState"]>("loading");
  const [quotes, setQuotes] = useState<{
    bid: number | null;
    ask: number | null;
    size: number | null;
  }>({
    bid: null,
    ask: null,
    size: null,
  });

  const loadBook = useCallback(async () => {
    if (location.kind !== "l1" && location.kind !== "rollup") {
      setQuotes({ bid: null, ask: null, size: null });
      setBookState(location.kind === "loading" ? "loading" : "unavailable");
      return;
    }
    try {
      const { market } = await loadManifestMarket(
        location.kind === "rollup" ? rollup : l1,
        marketAddress,
        MANIFEST_PROGRAM_ID,
      );
      const bids = aggregateBookSide(
        market.bids().map((order) => ({
          price: order.tokenPrice,
          size: Number(String(order.numBaseTokens)),
          order,
        })),
        "bid",
      );
      const asks = aggregateBookSide(
        [...market.asks()].map((order) => ({
          price: order.tokenPrice,
          size: Number(String(order.numBaseTokens)),
          order,
        })),
        "ask",
      );
      setQuotes({
        bid: bids[0]?.price ?? null,
        ask: asks[0]?.price ?? null,
        size: bids[0]?.size ?? null,
      });
      setBookState("ready");
    } catch {
      setQuotes({ bid: null, ask: null, size: null });
      setBookState("unavailable");
    }
  }, [l1, location.kind, marketAddress, rollup]);

  useEffect(() => {
    void loadBook();
    const timer = window.setInterval(() => void loadBook(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadBook]);

  const settlementSpot =
    oracle.state.kind === "ready"
      ? Number(
          fromRaw(
            oracle.state.quote.price,
            oracle.state.quote.decimals,
            oracle.state.quote.decimals,
          ),
        )
      : null;
  const spot = realtimeSpot ?? settlementSpot;
  const strike = Number(
    fromRaw(
      view.config.strike,
      view.config.priceDecimals,
      view.config.priceDecimals,
    ),
  );
  const distancePct = spot && spot > 0 ? ((strike - spot) / spot) * 100 : null;
  const executable = intent === "seller" ? quotes.bid : quotes.ask;
  const premiumPct =
    spot && spot > 0 && executable !== null ? (executable / spot) * 100 : null;

  return {
    spot,
    distancePct,
    bestBid: quotes.bid,
    bestBidSize: quotes.size,
    bookState,
    bestAsk: quotes.ask,
    premiumPct,
    volume24h: null,
    quoteState:
      realtimeSpot !== undefined && realtimeSpot !== null
        ? "ready"
        : profile
          ? "unavailable"
          : oracle.state.kind === "loading"
            ? "loading"
            : oracle.state.kind === "ready"
              ? "ready"
              : "unavailable",
  };
}
