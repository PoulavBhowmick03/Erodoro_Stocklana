"use client";

import Link from "next/link";
import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { LegName } from "@/lib/pdas";
import { useSeries } from "@/lib/use-series";
import { AppChrome } from "./app-chrome";
import { SeriesDetail } from "./series-detail";

export function TradeMarketShell() {
  return (
    <AppChrome
      title="Market"
      lede="Trade P and N against USDC."
      hideIntro
    >
      <Suspense fallback={<MarketSkeleton />}>
        <MarketRoute />
      </Suspense>
    </AppChrome>
  );
}

function MarketRoute() {
  const router = useRouter();
  const params = useSearchParams();
  const address = params.get("market");
  const leg: LegName = params.get("view")?.toLowerCase() === "p" ? "P" : "N";
  const { state, reload } = useSeries();

  const back = useCallback(() => router.push("/app"), [router]);
  const changeLeg = useCallback(
    (next: LegName) => {
      if (!address) return;
      router.replace(
        `/trade/markets?market=${address}&view=${next.toLowerCase()}`,
        { scroll: false },
      );
    },
    [address, router],
  );

  if (!address) {
    return <MissingMarket title="No market selected" message="Choose a market to view its order book and payoff." />;
  }
  if (state.kind === "loading") return <MarketSkeleton />;
  if (state.kind === "error") {
    return <MissingMarket title="Market unavailable" message={`Could not read this market: ${state.message}`} />;
  }
  if (state.kind === "undeployed") {
    return <MissingMarket title="Market unavailable" message="Erodoro is not deployed on the active cluster." />;
  }

  const selected =
    state.kind === "ready"
      ? state.series.find((series) => series.address.toBase58() === address)
      : undefined;

  if (!selected) {
    return (
      <MissingMarket title="Market unavailable" message="This market is not listed on the current cluster." />
    );
  }

  return (
    <SeriesDetail
      address={selected.address}
      config={selected.config}
      settlement={selected.settlement}
      initialLeg={leg}
      onLegChange={changeLeg}
      onBack={back}
      onDone={reload}
    />
  );
}

function MissingMarket({ title, message }: { title: string; message: string }) {
  return (
    <div className="border-line bg-panel rounded-md border p-8 text-center">
      <h1 className="text-lg font-medium">{title}</h1>
      <p className="text-muted mt-2 text-sm">{message}</p>
      <Link
        href="/app"
        className="border-line hover:border-text mt-5 inline-flex rounded-sm border px-4 py-2 text-sm transition-colors"
      >
        Browse markets
      </Link>
    </div>
  );
}

function MarketSkeleton() {
  return (
    <div className="space-y-4">
      <div className="border-line bg-panel h-36 animate-pulse rounded-md border" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="border-line bg-panel h-96 animate-pulse rounded-md border" />
        <div className="border-line bg-panel h-96 animate-pulse rounded-md border" />
      </div>
    </div>
  );
}
