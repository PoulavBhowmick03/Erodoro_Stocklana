"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { SolanaProvider } from "@/components/solana-provider";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletButton } from "@/components/wallet-button";
import { WalletMenu } from "@/components/app-chrome";
import { IS_DEVNET, NETWORK } from "@/lib/network-config";
import type { PoolLot, RipPosition, RipSource } from "@/lib/rips/model";
import type { LiveBook } from "@/lib/rips/live";
import {
  useMarks,
  useRipBuy,
  useRipMode,
  useRipPool,
  useRipPositions,
  type LivePoolState,
  type Mark,
} from "@/lib/rips/use-rips";

type RipsContext = {
  mode: RipSource;
  setMode: (m: RipSource) => void;
  canSwitch: boolean;
  lots: PoolLot[];
  liveLots: PoolLot[];
  liveState: LivePoolState;
  books: LiveBook[];
  positions: RipPosition[];
  marks: Map<string, Mark>;
  now: number;
  buy: ReturnType<typeof useRipBuy>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<RipsContext | null>(null);

export function useRips() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRips outside RipsShell");
  return v;
}

function RipsState({ children }: { children: ReactNode }) {
  const pool = useRipPool();
  const { mode, setMode, canSwitch } = useRipMode(pool.liveLots.length > 0);
  const { positions } = useRipPositions(mode);
  const marks = useMarks(positions, pool.books, pool.now);
  const buy = useRipBuy(mode);
  const value = useMemo<RipsContext>(
    () => ({
      mode,
      setMode,
      canSwitch,
      lots: mode === "demo" ? pool.demoLots : pool.liveLots,
      liveLots: pool.liveLots,
      liveState: pool.liveState,
      books: pool.books,
      positions,
      marks,
      now: pool.now,
      buy,
      refresh: pool.refresh,
    }),
    [mode, setMode, canSwitch, pool, positions, marks, buy],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const LINKS = [
  { href: "/market-rip", label: "Rip" },
  { href: "/rips", label: "My Rips" },
];

/**
 * The consumer chrome: brand, two destinations, wallet. The trading terminal
 * is one tap away under "Pro" for anyone who wants strikes and books, but it
 * is not what a first visit is asked to understand.
 */
function Header() {
  const pathname = usePathname();
  const { mode, setMode, canSwitch } = useRips();
  return (
    <header className="bg-bg border-line/70 sticky top-0 z-50 border-b">
      {IS_DEVNET && (
        <p className="border-n/30 text-n border-b px-4 py-1.5 text-center text-[0.8125rem]">
          Solana devnet · test assets have no real value
        </p>
      )}
      <nav aria-label="Rips" className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 sm:gap-4">
          <Logo href="/" />
          <div className="flex items-center gap-1">
            {LINKS.map((l) => {
              const active = pathname.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${active ? "bg-text text-bg" : "text-muted hover:text-text"}`}
                >
                  {l.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle compact />
          {IS_DEVNET ? <WalletMenu registry={false} /> : <WalletButton />}
        </div>
      </nav>
      {canSwitch && (
        <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-4 pb-3">
          <div role="radiogroup" aria-label="Rip pool" className="border-line bg-panel inline-flex rounded-full border p-0.5 text-[0.8125rem]">
            {(["live", "demo"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 transition-colors ${mode === m ? "bg-text text-bg" : "text-muted hover:text-text"}`}
              >
                {m === "live" ? `Live ${NETWORK.label}` : "Demo pool"}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function Footer() {
  const { mode } = useRips();
  return (
    <footer className="text-dim mx-auto w-full max-w-3xl px-4 pb-8 text-center text-xs leading-5">
      {mode === "demo"
        ? "Demo pool: simulated prices and positions. Nothing is bought and no funds move. "
        : "Live Rips are real upside claims bought from sellers on the order book. They can expire worth nothing. "}
      <Link href="/#how" className="underline underline-offset-2">How Erodoro works</Link>
    </footer>
  );
}

export function RipsShell({ children }: { children: ReactNode }) {
  return (
    <SolanaProvider>
      <RipsState>
        <Header />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16">{children}</main>
        <Footer />
      </RipsState>
    </SolanaProvider>
  );
}
