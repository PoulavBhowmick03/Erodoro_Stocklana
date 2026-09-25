"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Logo } from "./logo";
import { NavMenu, type NavItem } from "./nav-menu";
import { WalletButton } from "./wallet-button";
import { ThemeToggle } from "./theme-toggle";
import { TestWalletBar } from "./test-wallet";
import { TourButton } from "./tour";
import { useRole } from "./role-toggle";
import { usePrograms } from "@/lib/programs";
import { useSigner } from "@/lib/use-signer";
import { factoryPda } from "@/lib/pdas";
import { IS_DEVNET, NETWORK } from "@/lib/network-config";

const LEARN: NavItem[] = [
  { href: "/#how", label: "How it works" },
  { href: "/#payoff", label: "Payoff" },
  { href: "/#risk", label: "Risk" },
  { href: "/#faq", label: "FAQ" },
];
const TABS: NavItem[] = [
  { href: "/earn", label: "Earn" },
  { href: "/auctions", label: "Auctions" },
  { href: "/app", label: "Markets" },
  { href: "/market-rip", label: "Market Rip" },
  { href: "/swap", label: "Swap" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/rewards", label: "Rewards" },
];
const TESTNET_TABS: NavItem[] = [{ href: "/faucet", label: "Get test assets" }];

/** Base's visual shell, connected to this build's verified Solana network. */
export function AppChrome({
  active,
  title,
  lede,
  children,
  hideIntro = false,
  hideIntroOnSeries = false,
}: {
  active?: string;
  title?: string;
  lede?: string;
  children?: React.ReactNode;
  hideIntro?: boolean;
  hideIntroOnSeries?: boolean;
}) {
  const pathname = usePathname();
  const [, setRole] = useRole();
  const selected =
    active ??
    (pathname.startsWith("/trade/")
      ? "/app"
      : pathname === "/mint"
        ? "/faucet"
        : pathname);
  const tabs = [...TABS, ...(IS_DEVNET ? TESTNET_TABS : [])];
  const selectRole = (href: string) => {
    if (href === "/earn") setRole("seller");
  };
  return (
    <>
      <header className="border-line/80 bg-bg/88 sticky top-0 z-50 border-b backdrop-blur-md">
        <div className="border-n/30 bg-n/10 text-n border-b px-4 py-2 text-center text-[0.8125rem]">
          {IS_DEVNET
            ? "Solana devnet · Test assets have no real value"
            : "Solana Mainnet · Real funds · Trading requires verified deployments"}
        </div>
        <nav
          className="mx-auto flex min-h-[4.5rem] max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6"
          aria-label="App"
        >
          <div className="flex items-center gap-6">
            <Logo href="/" />
            <div className="hidden items-center gap-1 2xl:flex">
              {tabs.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  onClick={() => selectRole(t.href)}
                  aria-current={selected === t.href ? "page" : undefined}
                  data-tour={
                    t.href === "/portfolio" ? "nav-portfolio" : undefined
                  }
                  className={`border-b-2 px-3 py-2 text-[0.875rem] transition-colors ${selected === t.href ? "border-accent text-text" : "text-muted hover:text-text border-transparent"}`}
                >
                  {t.label}
                </Link>
              ))}
              <NavMenu label="Learn" items={LEARN} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {IS_DEVNET && <TourButton />}
            <span
              aria-label="App network"
              className="border-line bg-bg text-text rounded-sm border px-2 py-2 text-xs"
            >
              Solana {NETWORK.label}
            </span>
            <ThemeToggle />
            {IS_DEVNET ? (
              <WalletMenu registry={pathname === "/admin/registry"} />
            ) : (
              <WalletButton />
            )}
          </div>
        </nav>
        <nav
          className="border-line/80 flex max-w-full gap-2 overflow-x-auto border-t px-4 py-3 2xl:hidden"
          aria-label="App sections"
        >
          {[...tabs, { href: "/#how", label: "Learn" }].map((t) => (
            <Link
              key={t.href}
              href={t.href}
              onClick={() => selectRole(t.href)}
              aria-current={selected === t.href ? "page" : undefined}
              data-tour={
                t.href === "/portfolio" ? "nav-portfolio-mobile" : undefined
              }
              className={`shrink-0 rounded-sm border px-3 py-1.5 text-[0.8125rem] transition-colors ${selected === t.href ? "border-accent text-accent-ink" : "border-line text-muted"}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      {children && (
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
          {!hideIntro && !hideIntroOnSeries && title && (
            <div className="mb-6">
              <h1 className="font-display text-3xl tracking-[-0.045em]">
                {title}
              </h1>
              <p className="text-muted mt-3 max-w-[68ch] leading-7">{lede}</p>
            </div>
          )}
          {children}
        </main>
      )}
    </>
  );
}

function WalletMenu({ registry }: { registry: boolean }) {
  return (
    <details className="group relative">
      <summary className="border-line text-muted hover:text-text hover:border-text cursor-pointer list-none rounded-sm border px-3 py-2 text-[0.8125rem] whitespace-nowrap transition-colors">
        Select wallet
      </summary>
      {/* Anchored to the viewport on a phone and to the summary from `sm` up.
          Anchoring to the summary at every width put the panel's left edge
          off-screen, because the control it hangs from sits near the right
          edge of a 390px header. */}
      <div className="border-line bg-panel shadow-pop fixed top-[8.5rem] right-4 z-[80] w-[calc(100vw-2rem)] max-w-[26rem] space-y-3 rounded-md border p-4 sm:absolute sm:top-[calc(100%+0.5rem)] sm:right-0 sm:w-[26rem]">
        <div className="flex flex-wrap items-center gap-2">
          <WalletButton />
          <AdminRegistryLink mobile />
        </div>
        <TestWalletBar registry={registry} compact />
      </div>
    </details>
  );
}

function AdminRegistryLink({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  const signer = useSigner();
  const { factory } = usePrograms();
  const [authorized, setAuthorized] = useState(pathname === "/admin/registry");

  useEffect(() => {
    let live = true;
    if (!signer) {
      setAuthorized(pathname === "/admin/registry");
      return;
    }
    void (factory.account as any).factoryState
      .fetchNullable(factoryPda())
      .then((account: any | null) => {
        if (live) setAuthorized(Boolean(account?.admin?.equals(signer)));
      })
      .catch(() => {
        if (live) setAuthorized(pathname === "/admin/registry");
      });
    return () => {
      live = false;
    };
  }, [factory, pathname, signer]);

  if (!authorized) return null;
  return (
    <Link
      href="/admin/registry"
      aria-current={pathname === "/admin/registry" ? "page" : undefined}
      className={
        mobile
          ? `rounded-sm border px-3 py-1.5 text-sm ${pathname === "/admin/registry" ? "border-accent text-accent-ink" : "border-line text-muted"}`
          : `border-b px-3 py-5 text-sm transition-colors ${pathname === "/admin/registry" ? "border-accent text-accent-ink" : "border-transparent text-dim hover:text-text"}`
      }
    >
      Admin registry
    </Link>
  );
}
