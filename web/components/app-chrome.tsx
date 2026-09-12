"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Logo } from "./logo";
import { NavMenu, type NavItem } from "./nav-menu";
import { WalletButton } from "./wallet-button";
import { ThemeToggle } from "./theme-toggle";
import { TestWalletBar } from "./test-wallet";
import { TourButton } from "./tour";
import { usePrograms } from "@/lib/programs";
import { useSigner } from "@/lib/use-signer";
import { factoryPda } from "@/lib/pdas";
import { IS_DEVNET, NETWORK } from "@/lib/network-config";

/**
 * Header, nav and footer for every page inside the app.
 *
 * Extracted from `AppShell` once there was a second route: a page that nothing
 * links to is a page nobody finds, and the app had grown a second one with no
 * way to reach it.
 *
 * The nav is grouped rather than flat. Everything used to sit in one row, which
 * put "read what P and N are" beside "mint devnet scaffolding" beside "look at
 * what you are holding" as though they were peers. Now explanation collapses
 * into menus, the two surfaces you act on stay flat, and network administration
 * sits apart from both.
 */

/** Anchors on the landing page. Ids verified in `app/page.tsx`. */
const LEARN: NavItem[] = [
  { href: "/#how", label: "How it works", hint: "Create P and N, then trade the upside" },
  { href: "/#payoff", label: "Payoff", hint: "See how each claim settles" },
  { href: "/#risk", label: "Risk", hint: "Understand seller and buyer losses" },
  { href: "/#faq", label: "FAQ" },
];

/**
 * Devnet scaffolding. Hidden elsewhere: there is nothing to mint on a cluster
 * that has the real tokenized equities, and offering to on mainnet would say
 * the opposite of what is true.
 */
/** The two surfaces you act on. Flat, always visible. */
const PRIMARY: [string, string][] = [
  ["/app", "Markets"],
  ["/portfolio", "Portfolio"],
];

/**
 * `useSearchParams` opts its subtree into client rendering, and the chrome is
 * deliberately prerendered so `/app` still ships as a static file -- see the
 * note in `app-shell.tsx`. Isolating it here keeps that true: the fallback
 * renders the same links without the active highlight.
 */
function PrimaryLinks() {
  const pathname = usePathname();

  return (
    <>
      {PRIMARY.map(([href, label]) => {
        const isPositions = label === "Portfolio";
        const onMarket = pathname.startsWith("/trade/markets");
        const active =
          pathname === href ||
          (onMarket && !isPositions);
        return (
          <Link
            key={href}
            href={href}
            data-tour={isPositions ? "nav-portfolio" : undefined}
            aria-current={active ? "page" : undefined}
            className={`border-b px-3 py-5 text-sm transition-colors ${
              active ? "border-text text-text" : "border-transparent text-muted hover:text-text"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}

function PrimaryLinksFallback() {
  return (
    <>
      {PRIMARY.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          data-tour={label === "Portfolio" ? "nav-portfolio" : undefined}
          className="border-b border-transparent px-3 py-5 text-sm text-muted transition-colors hover:text-text"
        >
          {label}
        </Link>
      ))}
    </>
  );
}

export function AppChrome({
  title,
  lede,
  children,
  hideIntroOnSeries = false,
  hideIntro = false,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
  hideIntroOnSeries?: boolean;
  hideIntro?: boolean;
}) {
  const pathname = usePathname();
  const onDevnet = IS_DEVNET;

  const onAdminRegistry = pathname === "/admin/registry";

  return (
    <>
      <header className="border-line bg-bg/90 sticky top-0 z-50 border-b backdrop-blur-md">
        {/* Five controls in one row does not fit a phone. The network label and
            the full devnet-tools wording are the two that repeat elsewhere (the
            footer, and the menu itself), so they are what gives way — the
            wallet button never shrinks, because a clipped connect button is the
            one control nobody can work around. */}
        <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <Logo href="/" />
            <span className="border-line text-dim hidden shrink-0 rounded-sm border px-2 py-0.5 font-mono text-[0.8125rem] tracking-[0.1em] uppercase sm:inline-block">
              {NETWORK.label}
            </span>
            <nav className="hidden items-center gap-1 sm:flex">
              <NavMenu label="Learn" items={LEARN} />
              <Suspense fallback={<PrimaryLinksFallback />}>
                <PrimaryLinks />
              </Suspense>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onDevnet && (
              <>
                <Link
                  href="/mint"
                  className="border-line text-muted hover:text-text hover:border-text hidden rounded-sm border px-3 py-2 text-[0.8125rem] whitespace-nowrap transition-colors sm:inline-flex"
                >
                  Create demo assets
                </Link>
                <TourButton />
              </>
            )}
            <ThemeToggle />
            {onDevnet ? (
              <WalletMenu registry={onAdminRegistry} />
            ) : (
              <WalletButton />
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-12">
        <Suspense fallback={<PageIntroContent title={title} lede={lede} />}>
          <PageIntro
            title={title}
            lede={lede}
            hideOnSeries={hideIntroOnSeries}
            hidden={hideIntro}
          />
        </Suspense>

        {/* Small screens lose the header nav, so it reappears here rather than
            leaving a route unreachable on a phone. The menus flatten: a
            dropdown inside a wrapped row is worse than four more links. */}
        <nav className="mb-8 flex flex-wrap gap-2 sm:hidden">
          {[
            ...PRIMARY,
            ["/#how", "Learn"] as [string, string],
            ...(onDevnet ? [["/mint", "Create demo assets"] as [string, string]] : []),
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              data-tour={label === "Portfolio" ? "nav-portfolio" : undefined}
              className={`rounded-sm border px-3 py-1.5 text-sm ${
                pathname === href ? "border-accent text-accent-ink" : "border-line text-muted"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>

        {children}
      </main>

      <footer className="border-line border-t">
        <div className="text-dim mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-sm">
          <Link href="/" className="hover:text-text transition-colors">
            ← Back to site
          </Link>
          <span>
            {onDevnet
              ? "Devnet demo · nothing here represents real value"
              : "Mainnet · issuer assets and market risks apply"}
          </span>
        </div>
      </footer>
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
      <div className="border-line bg-panel shadow-pop fixed top-[4.5rem] right-4 z-[80] w-[calc(100vw-2rem)] max-w-[26rem] space-y-3 rounded-md border p-4 sm:absolute sm:top-[calc(100%+0.5rem)] sm:right-0 sm:w-[26rem]">
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
    return () => { live = false; };
  }, [factory, pathname, signer]);

  if (!authorized) return null;
  return (
    <Link
      href="/admin/registry"
      aria-current={pathname === "/admin/registry" ? "page" : undefined}
      className={mobile
        ? `rounded-sm border px-3 py-1.5 text-sm ${pathname === "/admin/registry" ? "border-accent text-accent-ink" : "border-line text-muted"}`
        : `border-b px-3 py-5 text-sm transition-colors ${pathname === "/admin/registry" ? "border-accent text-accent-ink" : "border-transparent text-dim hover:text-text"}`}
    >
      Admin registry
    </Link>
  );
}

function PageIntro({
  title,
  lede,
  hideOnSeries = false,
  hidden = false,
}: {
  title: string;
  lede: string;
  hideOnSeries?: boolean;
  hidden?: boolean;
}) {
  const params = useSearchParams();
  if (hidden) return null;
  if (hideOnSeries && params.has("series")) return null;
  return <PageIntroContent title={title} lede={lede} />;
}

function PageIntroContent({ title, lede }: { title: string; lede: string }) {
  return (
    <div className="border-line mb-10 grid gap-3 border-b pb-8 md:grid-cols-[minmax(0,1fr)_minmax(20rem,0.75fr)] md:items-end">
      <h1 className="text-4xl font-medium tracking-[-0.045em] sm:text-5xl">{title}</h1>
      <p className="text-muted max-w-[62ch] text-[0.95rem] leading-7 md:justify-self-end">{lede}</p>
    </div>
  );
}
