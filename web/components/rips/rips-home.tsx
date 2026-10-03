"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import { IS_DEVNET } from "@/lib/network-config";
import { RIP_PRICE, pctChange, signedPct, totalPaid, usd, type PoolLot } from "@/lib/rips/model";
import { DemoBadge, TickerMark } from "./bits";
import { RipCard } from "./rip-card";
import { RipOverlay, useRipFlow } from "./rip-flow";
import { useRips } from "./rips-shell";

/** Ticker chips drifting behind the button: what is in the pool, not which one you get. */
function PoolDrift({ lots }: { lots: PoolLot[] }) {
  const symbols = useMemo(() => [...new Set(lots.map((l) => l.symbol))], [lots]);
  if (symbols.length === 0) return null;
  const row = [...symbols, ...symbols, ...symbols, ...symbols].slice(0, Math.max(8, symbols.length * 2));
  const chips = (key: string) =>
    [...row, ...row].map((s, i) => (
      <span
        key={`${key}${i}`}
        className="border-line bg-panel/80 inline-flex items-center gap-2 rounded-full border py-1.5 pr-3.5 pl-1.5"
      >
        <TickerMark symbol={s} size={26} />
        <span className="font-display text-[0.95rem] font-semibold tracking-[-0.02em]">
          {s} <span className="text-p">↑</span>
        </span>
      </span>
    ));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-[-1rem] top-1/2 -translate-y-1/2 space-y-3 overflow-hidden opacity-55 [mask-image:linear-gradient(90deg,transparent,black_18%,black_82%,transparent)]"
    >
      <div className="rip-marquee">{chips("a")}</div>
      <div className="rip-marquee rip-marquee--reverse">{chips("b")}</div>
      <div className="rip-marquee">{chips("c")}</div>
    </div>
  );
}

export function RipsHome() {
  const { mode, modeReady, setMode, canSwitch, lots, liveState, positions, marks, now, buy, balance } = useRips();
  const { stage, rip, close } = useRipFlow();
  const { setVisible } = useWalletModal();

  const ripable = lots.filter((l) => l.availableUsd >= RIP_PRICE * 0.98);
  const poolUsd = ripable.reduce((s, l) => s + l.availableUsd, 0);
  const needsWallet = modeReady && mode === "live" && !buy.signer;
  const poolEmpty = ripable.length === 0;
  const loading = !modeReady || (mode === "live" && liveState === "loading");

  const portfolio = positions.reduce(
    (acc, p) => {
      acc.paid += totalPaid(p);
      acc.value += marks.get(p.id)?.value ?? totalPaid(p);
      return acc;
    },
    { paid: 0, value: 0 },
  );
  const sorted = [...positions].sort((a, b) => Math.max(...b.fills.map((f) => f.at)) - Math.max(...a.fills.map((f) => f.at)));

  const why = loading
    ? "Reading the pool…"
    : liveState === "undeployed" && mode === "live"
      ? "Erodoro isn’t deployed on this network yet."
      : poolEmpty
        ? "The pool is empty right now. New positions appear as sellers list them."
        : null;

  const onRip = () => {
    if (needsWallet) {
      setVisible(true);
      return;
    }
    void rip();
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3 pt-5 text-sm">
        {!modeReady ? (
          <span />
        ) : mode === "demo" ? (
          <DemoBadge />
        ) : (
          <span className="text-muted tabular-nums">
            {buy.signer ? (balance === null ? "…" : `${usd(balance, 2)} USDC`) : "Not connected"}
          </span>
        )}
        {positions.length > 0 && (
          <Link href="/rips" className="text-muted hover:text-text tabular-nums">
            My Rips <span className="text-text font-medium">{usd(portfolio.value)}</span>{" "}
            <span className={portfolio.value >= portfolio.paid ? "text-p" : "text-danger"}>
              {signedPct(pctChange(portfolio.value, portfolio.paid))}
            </span>
          </Link>
        )}
      </div>

      <section className="pt-10 text-center sm:pt-14" aria-labelledby="rip-title">
        <p className="text-accent-ink text-xs font-semibold tracking-[0.28em] uppercase">Market Rip</p>
        <h1 id="rip-title" className="font-display mt-3 text-[2.75rem] leading-[1] font-semibold tracking-[-0.05em] sm:text-6xl">
          $1. Pull a move.
        </h1>

        <div className="relative my-10 flex h-64 items-center justify-center sm:h-72">
          <PoolDrift lots={ripable} />
          <button
            type="button"
            onClick={onRip}
            disabled={!needsWallet && (!!why || stage.kind !== "idle")}
            aria-describedby="rip-sub"
            title={!needsWallet && why ? why : undefined}
            className="rip-cta rip-cta--hero relative z-10 h-32 w-[min(20rem,82vw)] text-[3.25rem] sm:h-36 sm:text-6xl"
          >
            RIP $1
          </button>
        </div>

        <p id="rip-sub" className="text-muted mx-auto max-w-xs text-sm leading-6">
          {needsWallet
            ? "Connect a wallet to Rip. Each Rip buys about $1 of a real position."
            : (why ??
              (mode === "demo"
                ? `A random simulated position from the demo pool. Nothing is bought.`
                : `A random live position from ${usd(poolUsd, 0)} on offer across ${ripable.length} ${ripable.length === 1 ? "market" : "markets"}. Revealed after you pay.`))}
        </p>
        {canSwitch && mode === "live" && (poolEmpty || liveState === "undeployed") && !loading && (
          <button type="button" onClick={() => setMode("demo")} className="text-accent-ink mt-3 text-sm font-medium underline underline-offset-4">
            Try the demo pool
          </button>
        )}
      </section>

      <section className="mt-14" aria-labelledby="my-rips-preview">
        <div className="flex items-baseline justify-between">
          <h2 id="my-rips-preview" className="font-display text-2xl font-semibold tracking-[-0.04em]">
            My Rips
          </h2>
          {positions.length > 0 && (
            <Link href="/rips" className="text-muted hover:text-text text-sm">
              See all →
            </Link>
          )}
        </div>
        {positions.length === 0 ? (
          <p className="text-muted border-line mt-4 rounded-2xl border border-dashed p-6 text-center text-sm">
            Nothing yet. Your Rips land here and move with the market.
          </p>
        ) : (
          <div className="-mx-4 mt-4 flex gap-3 overflow-x-auto px-4 pb-2">
            {sorted.slice(0, 8).map((p) => (
              <RipCard key={p.id} position={p} mark={marks.get(p.id)} now={now} compact />
            ))}
          </div>
        )}
      </section>

      <details className="border-line/70 mt-12 border-t pt-5 text-sm">
        <summary className="cursor-pointer font-medium">What is a Rip?</summary>
        <div className="text-muted mt-3 space-y-2 leading-6">
          <p>
            A Rip spends $1 on a randomly chosen position from the pool. Every position is an upside claim on a{" "}
            {IS_DEVNET ? "token" : "tokenized stock"}: it pays based on how far the price ends above a set level on a set date.
          </p>
          <p>
            You get a real, fractional position bought from a seller who listed it — not points, not an NFT. If the price
            finishes below the level, the position expires worth nothing.
          </p>
          <p>Like what you pulled? Buy more of that exact position from its detail page.</p>
        </div>
      </details>

      <RipOverlay stage={stage} onRipAgain={() => void rip()} onClose={close} />
    </>
  );
}
