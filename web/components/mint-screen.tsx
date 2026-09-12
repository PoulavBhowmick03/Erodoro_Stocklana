"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { DevnetSetupProgress } from "./devnet-setup-progress";
import { MintPanel } from "./mint-panel";
import { QuotePanel } from "./quote-panel";
import { useTestWallet } from "./test-wallet";
import { TokenBalances } from "./token-balances";
import { shortKey } from "@/lib/format";
import { useSigner } from "@/lib/use-signer";
import { LAST_MINT_KEY } from "@/lib/use-token-balances";
import { RETURN_PARAM, safeReturnTo } from "@/lib/return-to";

type SetupStep = 0 | 1 | 2;

/** One horizontal setup journey. Only the current job is rendered. */
export function MintScreen() {
  const signer = useSigner();
  const { role } = useTestWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const [stockReady, setStockReady] = useState(false);
  const [cashReady, setCashReady] = useState(false);
  const [step, setStep] = useState<SetupStep>(0);

  useEffect(() => {
    const hasStock = Boolean(window.sessionStorage.getItem(LAST_MINT_KEY));
    const hasCash = true;
    setStockReady(hasStock);
    setCashReady(hasCash);
    setStep(hasStock ? (hasCash ? 2 : 1) : 0);
  }, []);

  const recipient = signer
    ? `${role ?? "connected wallet"} · ${shortKey(signer, 6)}`
    : "Choose a test key";
  const stepCopy = [
    ["Create the collateral", "Mint valueless demo collateral whose payoff is linked to SOL/USD."],
    ["Confirm the quote token", "The shared demo USDC mint is already available."],
    ["Hand off to the admin", "Approve the collateral and list its first market."],
  ][step];

  return (
    <div className="space-y-4">
      {/* `useSearchParams` opts its subtree into client rendering; isolating it
          keeps the rest of this page prerendered in the static export. */}
      <Suspense fallback={null}>
        <ReturnBanner />
      </Suspense>

      <DevnetSetupProgress
        current={step}
        completed={[stockReady, cashReady, false, false]}
        onSelect={(index) => {
          if (index <= 2) setStep(index as SetupStep);
        }}
      />

      <div className="border-line flex flex-wrap items-center justify-between gap-2 border-b pb-4">
        <div>
          <h2 className="font-display text-2xl tracking-[-0.035em]">{stepCopy[0]}</h2>
          <p className="text-muted mt-1 text-sm">{stepCopy[1]}</p>
        </div>
        <div className="text-dim font-mono text-[0.8125rem] tracking-[0.08em] uppercase">
          For <span className="text-text normal-case tracking-normal">{recipient}</span>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div>
          {step === 0 && (
            <MintPanel
              onMinted={() => {
                setStockReady(true);
                setRefreshKey((value) => value + 1);
                setStep(1);
              }}
            />
          )}

          {step === 1 && (
            <QuotePanel
              onCreated={() => {
                setCashReady(true);
                setRefreshKey((value) => value + 1);
                setStep(2);
              }}
            />
          )}

          {step === 2 && (
            <section data-tour="registry-handoff" className="border-line bg-panel rounded-md border p-6">
              <div className="text-accent-ink font-mono text-[0.8125rem] tracking-[0.12em] uppercase">Step 3 · Admin</div>
              <h2 className="mt-2 text-2xl font-medium tracking-[-0.03em]">List the market</h2>
              <p className="text-muted mt-2 max-w-xl text-sm leading-6">The admin approves the collateral and sets its strike and expiry. Trading is prepared automatically after listing.</p>
              <Link href="/admin/registry" className="bg-text hover:bg-accent text-bg mt-5 inline-flex items-center gap-4 rounded-sm px-4 py-2.5 text-sm font-medium transition-colors">Open admin listing <span aria-hidden>→</span></Link>
            </section>
          )}
        </div>

        <aside className="border-line bg-panel rounded-md border p-5">
          <div className="eyebrow">Setup status</div>
          <dl className="mt-4 divide-y divide-[var(--color-line-soft)]">
            {[
              ["SOL-linked collateral", stockReady],
              ["Demo USDC", cashReady],
              ["Market listing", false],
            ].map(([label, done]) => (
              <div key={String(label)} className="flex items-center justify-between gap-4 py-3 text-sm">
                <dt className="text-muted">{String(label)}</dt>
                <dd className={done ? "text-p" : "text-dim"}>{done ? "Ready" : "Pending"}</dd>
              </div>
            ))}
          </dl>
          <p className="text-dim mt-4 text-xs leading-5">Every asset created here is valueless and exists only on Solana devnet.</p>
        </aside>
      </div>

      <details className="border-line bg-panel rounded-md border">
        <summary className="text-muted hover:text-text cursor-pointer px-4 py-3 text-sm transition-colors">
          View created assets
        </summary>
        <div className="border-line-soft border-t p-4">
          <TokenBalances refreshKey={refreshKey} tour="balances" title="Your demo assets" />
        </div>
      </details>
    </div>
  );
}

/**
 * The way back to whatever sent you here.
 *
 * A buyer arrives from a market they had already composed an order on. Without
 * this they finish funding and are left on a setup page with no indication that
 * their order is still waiting, and no link back to it.
 *
 * The destination is validated rather than trusted -- see `lib/return-to.ts`.
 */
function ReturnBanner() {
  const params = useSearchParams();
  const back = safeReturnTo(params.get(RETURN_PARAM));
  if (!back) return null;

  return (
    <aside className="border-bid/35 bg-bid/8 flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-2.5">
      <p className="text-bid text-[0.85rem]">
        Funding for an order you already composed. It is still waiting.
      </p>
      <Link
        href={back}
        className="bg-bid text-ink hover:bg-bid/90 rounded-sm px-3 py-1.5 text-[0.8rem] font-medium transition-colors"
      >
        Back to the market
      </Link>
    </aside>
  );
}
