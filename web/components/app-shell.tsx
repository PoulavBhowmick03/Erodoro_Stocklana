"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppChrome } from "./app-chrome";
import { MarketsTable } from "./markets-table";
import { MarketplaceIntro } from "./marketplace-intro";
import { useRole } from "./role-toggle";
import { IS_DEVNET } from "@/lib/network-config";

export function AppShell() {
  return (
    <AppChrome
      title="Markets"
      lede="Choose a tokenized equity, strike and expiry. Owners can create P and N and sell their upside; buyers can purchase the upside without margin."
      hideIntroOnSeries
    >
      {/*
        `useSearchParams` forces the tree below it to render on the client. The
        boundary keeps the chrome above prerendered, which is what makes this
        page still ship as a static file.
      */}
      <Suspense fallback={<Skeleton />}>
        <Routed />
      </Suspense>
    </AppChrome>
  );
}

/**
 * Contracts is discovery only. Every selected contract opens the one dedicated
 * market route so the guide, normal browsing, portfolio links, and shared URLs
 * cannot produce different trading interfaces.
 */
function Routed() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("series") ?? params.get("market");
  const [role] = useRole();

  const open = useCallback(
    (address: string) => router.push(`/trade/markets?market=${address}&view=n`),
    [router],
  );

  // Preserve old shared links without preserving the old duplicate market UI.
  if (selected) {
    return <LegacyMarketRedirect address={selected} />;
  }

  const view = params.get("view");
  if (view === "positions") return <PortfolioRedirect />;
  return (
    <div className="space-y-4">
      <MarketplaceIntro />
      <div data-tour="series-list">
        <MarketsTable onOpen={open} intent={role} />
      </div>
      <DevnetNotice />
    </div>
  );
}

function DevnetNotice() {
  const [visible, setVisible] = useState(true);
  if (!IS_DEVNET || !visible) return null;
  return (
    <aside data-tour="test-stock-entry" className="border-line text-muted mt-5 flex flex-wrap items-center justify-between gap-3 border-y py-3 text-[0.8125rem]">
      <span>Devnet sandbox · demo assets have no real value.</span>
      <span className="flex items-center gap-4">
        <Link href="/mint" className="text-accent-ink hover:underline">Create demo assets</Link>
        <button type="button" onClick={() => setVisible(false)} className="text-dim hover:text-text">Dismiss</button>
      </span>
    </aside>
  );
}

function PortfolioRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/portfolio"), [router]);
  return <Skeleton />;
}

function LegacyMarketRedirect({ address }: { address: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/trade/markets?market=${address}&view=n`);
  }, [address, router]);
  return <Skeleton />;
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-line bg-panel h-14 animate-pulse rounded-lg border" />
      ))}
    </div>
  );
}
