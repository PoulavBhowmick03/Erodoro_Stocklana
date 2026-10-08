"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";

import { SolanaProvider } from "@/components/solana-provider";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletButton } from "@/components/wallet-button";
import { useTestWallet } from "@/components/test-wallet";
import { QUOTE_MINT } from "@/lib/deployment";
import { IS_DEVNET, NETWORK } from "@/lib/network-config";
import { USER_ROLES } from "@/lib/test-wallets";
import { DEMO_MODE } from "@/lib/demo-config";
import { buyStub, markStub, stubLots } from "@/lib/demo/ledger";
import { changeDemo, useDemoLedger } from "@/lib/demo/store";
import { DemoHeader, DemoControls } from "@/components/demo/demo-app";
import type { PoolLot, RipPosition, RipSource } from "@/lib/rips/model";
import type { LiveBook } from "@/lib/rips/live";
import { positionsKey, useStoredPositions } from "@/lib/rips/store";
import {
  useMarks,
  useRipBuy,
  useRipMode,
  useRipPool,
  useRipPositions,
  useLivePositions,
  useRipHistory,
  type LivePoolState,
  type Mark,
} from "@/lib/rips/use-rips";

type RipsContext = {
  mode: RipSource;
  /** False until the default pool has been decided; nothing should act before. */
  modeReady: boolean;
  setMode: (m: RipSource) => void;
  canSwitch: boolean;
  lots: PoolLot[];
  liveLots: PoolLot[];
  liveState: LivePoolState;
  books: LiveBook[];
  positions: RipPosition[];
  /** Rips kept in the pool not being viewed, so My Rips can say where they are. */
  otherModeCount: number;
  marks: Map<string, Mark>;
  now: number;
  buy: { buy: ReturnType<typeof useRipBuy>["buy"]; signer: PublicKey | null; flow: Pick<ReturnType<typeof useRipBuy>["flow"], "flow"> };
  /** Wallet USDC; null while unknown or with no signer. */
  balance: number | null;
  refresh: () => Promise<void>;
};

const Ctx = createContext<RipsContext | null>(null);

export function useRips() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRips outside RipsShell");
  return v;
}

function useUsdcBalance(owner: PublicKey | null) {
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  const read = useCallback(async () => {
    if (!owner) {
      setBalance(null);
      return;
    }
    try {
      const r = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(QUOTE_MINT, owner), "confirmed");
      setBalance(Number(r.value.uiAmount ?? 0));
    } catch {
      setBalance(0);
    }
  }, [connection, owner]);
  useEffect(() => {
    void read();
    const t = window.setInterval(() => void read(), 15_000);
    return () => window.clearInterval(t);
  }, [read]);
  return { balance, refreshBalance: read };
}

function RipsState({ children }: { children: ReactNode }) {
  const pool = useRipPool();
  const { mode, ready, setMode, canSwitch } = useRipMode(pool.liveLots.length > 0, pool.liveState);
  const { positions: recorded, signer } = useRipPositions(mode);
  const history = useRipHistory(mode);
  const positions = useLivePositions(recorded, history.purchases, pool.books, mode, pool.now);
  const other = useStoredPositions(positionsKey(signer?.toBase58() ?? null, mode === "live"));
  const marks = useMarks(positions, pool.books, pool.now);
  const rawBuy = useRipBuy(mode);
  const { balance, refreshBalance } = useUsdcBalance(rawBuy.signer);

  // A confirmed purchase changes the wallet and the pool at once; re-read both
  // then rather than waiting for the next poll, so nothing on screen is stale.
  const refreshPool = pool.refresh;
  const refreshHistory = history.refresh;
  const buy = useMemo<ReturnType<typeof useRipBuy>>(
    () => ({
      ...rawBuy,
      buy: async (lot, budget, kind) => {
        const result = await rawBuy.buy(lot, budget, kind);
        if (lot.source === "live") {
          void refreshPool();
          void refreshHistory();
          await refreshBalance();
        }
        return result;
      },
    }),
    [rawBuy, refreshBalance, refreshPool, refreshHistory],
  );

  const value = useMemo<RipsContext>(
    () => ({
      mode,
      modeReady: ready,
      setMode,
      canSwitch,
      lots: mode === "demo" ? pool.demoLots : pool.liveLots,
      liveLots: pool.liveLots,
      liveState: pool.liveState,
      books: pool.books,
      positions,
      otherModeCount: other.positions.length,
      marks,
      now: pool.now,
      buy,
      balance,
      refresh: pool.refresh,
    }),
    [mode, ready, setMode, canSwitch, pool, positions, other.positions.length, marks, buy, balance],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The demo mounts no Solana hooks, wallet adapters, RPC checks or signing state. */
function DemoRipsState({ children }: { children: ReactNode }) {
  const state = useDemoLedger();
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const now = clock + state.offset;
  const buy: RipsContext["buy"] = {
    signer: null, flow: { flow: null },
    buy: async (lot, budget, kind) => {
      try {
        let result!: ReturnType<typeof buyStub>;
        changeDemo((latest) => {
          result = buyStub(latest, lot.id, budget, kind, Math.floor(Date.now() / 1000) + latest.offset);
          return result.state;
        });
        return { ok: true, position: result.position, fill: result.fill };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  const value: RipsContext = {
    mode: "demo", modeReady: clock > 0, setMode: () => {}, canSwitch: false,
    lots: stubLots(state, now), liveLots: [], liveState: "ready", books: [],
    positions: state.positions, otherModeCount: 0,
    marks: new Map(state.positions.map((p) => [p.id, markStub(p, state, now)])),
    now, buy, balance: state.cash, refresh: async () => {},
  };
  return <Ctx.Provider value={value}>{clock > 0 ? children : <p role="status" className="p-6 text-sm">Loading demo wallet…</p>}</Ctx.Provider>;
}

const LINKS = [
  { href: "/market-rip", label: "Rip" },
  { href: "/rips", label: "My Rips" },
];

/**
 * Who is signing, chosen in one place. On devnet the demo accounts come
 * first: they are the fastest way to try a Rip, and putting the extension
 * button above them meant people clicked it and never saw the accounts.
 */
function RipsWalletMenu() {
  const { role, setRole } = useTestWallet();
  const { publicKey } = useWallet();
  const menu = useRef<HTMLDetailsElement>(null);
  const label = role
    ? `Demo ${role}`
    : publicKey
      ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`
      : "Wallet";
  const pick = (r: (typeof USER_ROLES)[number] | null) => {
    setRole(r);
    if (menu.current) menu.current.open = false;
  };
  return (
    <details ref={menu} className="relative">
      <summary className="border-line hover:border-text cursor-pointer list-none rounded-full border px-3 py-1.5 text-sm whitespace-nowrap">
        {/* "Demo" drops on phones, where the full label pushes the header past the screen edge. */}
        {role ? (
          <>
            <span className="max-sm:hidden">Demo </span>
            <span className="max-sm:capitalize">{role}</span>
          </>
        ) : (
          label
        )}{" "}
        <span aria-hidden>▾</span>
      </summary>
      <div className="border-line bg-panel fixed top-[7.5rem] right-4 z-[80] w-[calc(100vw-2rem)] max-w-[20rem] rounded-2xl border p-4 shadow-[var(--shadow-pop)] sm:absolute sm:top-[calc(100%+0.5rem)] sm:right-0">
        <p className="text-sm font-semibold">Demo accounts</p>
        <p className="text-dim mt-0.5 text-xs">Free devnet test accounts. No extension needed.</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {USER_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={role === r}
              onClick={() => pick(role === r ? null : r)}
              className={`rounded-full border py-2 text-sm font-medium capitalize transition-colors ${role === r ? "border-text bg-text text-bg" : "border-line hover:border-text"}`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="border-line/70 mt-4 border-t pt-3">
          <p className="text-sm font-semibold">Your own wallet</p>
          <div className="mt-2" onClick={() => role && setRole(null)}>
            <WalletButton />
          </div>
        </div>
      </div>
    </details>
  );
}

function Header() {
  const pathname = usePathname();
  const { mode, modeReady, setMode, canSwitch } = useRips();
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
          {IS_DEVNET ? <RipsWalletMenu /> : <WalletButton />}
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
                aria-checked={modeReady && mode === m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 transition-colors ${modeReady && mode === m ? "bg-text text-bg" : "text-muted hover:text-text"}`}
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
  if (DEMO_MODE) return (
    <DemoRipsState>
      <DemoHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16">{children}<DemoControls /></main>
      <Footer />
    </DemoRipsState>
  );
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
