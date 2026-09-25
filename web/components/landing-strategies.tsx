"use client";
import Link from "next/link";
import { useSeries } from "@/lib/use-series";
import { marketAsset } from "@/lib/market-presentation";
import { formatDate, priceToUsd } from "@/lib/format";
import { SolanaProvider } from "./solana-provider";

export function LandingStrategies() {
  return (
    <section
      className="border-line border-b"
      aria-labelledby="landing-strategies"
    >
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h2 id="landing-strategies" className="display-3">
          Find your stock strategy
        </h2>
        <p className="text-muted mt-3 max-w-[65ch]">
          Compare sell prices and expiry dates. View each market for current
          bids and available liquidity.
        </p>
        <div className="mt-6 [&_main]:min-h-0 [&_main]:px-0 [&_main]:py-2">
          <SolanaProvider>
            <StrategyList />
          </SolanaProvider>
        </div>
        <Link
          href="/earn"
          className="text-accent-ink mt-6 inline-flex text-sm underline underline-offset-4"
        >
          Explore Earn →
        </Link>
      </div>
    </section>
  );
}
function StrategyList() {
  const { state } = useSeries();
  if (state.kind === "loading")
    return (
      <p role="status" className="text-muted">
        Checking current strategies…
      </p>
    );
  if (state.kind !== "ready")
    return (
      <p className="text-muted">
        Strategies are unavailable. Check the current deployment from Markets.
      </p>
    );
  const active = state.series
    .filter(
      (s) =>
        !s.settlement &&
        "open" in s.config.status &&
        s.config.maturityTs.toNumber() > Date.now() / 1000,
    )
    .slice(0, 3);
  if (!active.length)
    return (
      <p className="text-muted">
        No active strategies are listed right now. Explore the markets and their
        terms.
      </p>
    );
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {active.map((s) => {
        const asset = marketAsset(s);
        return (
          <article
            key={s.address.toBase58()}
            className="border-line bg-panel rounded-md border p-5"
          >
            <h3 className="text-lg font-medium">{asset.name}</h3>
            <p className="text-muted mt-2 text-sm">
              {asset.symbol} ·{" "}
              {priceToUsd(s.config.strike, s.config.priceDecimals)} sell price
            </p>
            <p className="text-dim mt-2 font-mono text-xs">
              Expires {formatDate(s.config.maturityTs.toNumber())}
            </p>
            <Link
              href={`/trade/markets?market=${s.address.toBase58()}&view=n`}
              className="text-accent-ink mt-4 inline-flex text-sm underline"
            >
              View strategy →
            </Link>
          </article>
        );
      })}
    </div>
  );
}
