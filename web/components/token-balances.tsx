"use client";

import { useEffect, useState } from "react";
import { displayAmount, useTokenBalances, type Holding } from "@/lib/use-token-balances";
import { Panel } from "./ui";

/**
 * What the current signer actually holds.
 *
 * The mint screen used to confirm a mint and then forget it: the address showed
 * once, in a panel that vanished on reload, and nothing anywhere said how many
 * tokens the key was holding. So "did that work" and "which of these did I
 * make" were unanswerable a minute later, which is a strange gap on a page
 * whose only job is producing test collateral.
 *
 * `onPick` is what makes this more than a readout. On the create screen it
 * fills the collateral field, so the address never has to be copied by hand.
 */
export function TokenBalances({
  refreshKey = 0,
  onPick,
  title = "Your test tokens",
  heading,
  emptyText = "Nothing yet. Mint some above and it will show up here.",
  tour,
  onHoldings,
  only,
  collapsible = false,
}: {
  refreshKey?: number;
  onPick?: (mint: string) => void;
  title?: string;
  heading?: "h2" | "h3";
  /** "Above" is only true on the mint screen, where the button actually is. */
  emptyText?: string;
  tour?: string;
  /**
   * Restrict to one token program. The create screen sets this, because
   * offering a classic-SPL mint as collateral would produce a paste that fails
   * a constraint two steps later for a reason the screen never mentioned.
   */
  only?: "token-2022" | "spl";
  /**
   * Fired whenever a read completes. Exists so the create screen can prefill
   * its collateral field from one RPC round rather than duplicating the hook
   * higher up the tree and paying for the same two calls twice.
   */
  onHoldings?: (holdings: Holding[]) => void;
  /**
   * Start closed, behind a count. The create screen is a picker, not a
   * readout: twelve balances rendered as cards took 41% of that page's height
   * and pushed the thing you came to do below the fold. `onHoldings` still
   * fires while closed, so the collateral field prefills either way.
   */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const raw = useTokenBalances(refreshKey);
  const { reload } = raw;
  const state: typeof raw.state =
    raw.state.kind === "ready" && only
      ? { kind: "ready", holdings: raw.state.holdings.filter((h) => h.program === only) }
      : raw.state;

  useEffect(() => {
    if (state.kind === "ready") onHoldings?.(state.holdings);
    // `onHoldings` is intentionally not a dependency: callers pass an inline
    // closure, and depending on it would fire this on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Panel
      tour={tour}
      title={title}
      heading={heading}
      subtitle={
        state.kind === "ready" && state.holdings.length > 0
          ? "Token-2022 balances held by the key you are signing with."
          : undefined
      }
    >
      {state.kind === "loading" && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="bg-panel-2 h-16 animate-pulse rounded-sm" />
          ))}
        </div>
      )}

      {state.kind === "error" && (
        <p className="text-danger text-[0.85rem]">Could not read balances. {state.message}</p>
      )}

      {state.kind === "ready" && state.holdings.length === 0 && (
        <p className="text-dim text-[0.88rem]">{emptyText}</p>
      )}

      {state.kind === "ready" && state.holdings.length > 0 && (
        <>
          {collapsible && (
            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="text-muted hover:text-text text-[0.88rem] underline-offset-2 transition-colors hover:underline"
            >
              {open ? "Hide" : `Show`} {state.holdings.length} balance
              {state.holdings.length === 1 ? "" : "s"}
            </button>
          )}
          {open && (
            <ul className={`space-y-2 ${collapsible ? "mt-3" : ""}`}>
              {state.holdings.map((h) => (
                <Row key={h.account} holding={h} onPick={onPick} />
              ))}
            </ul>
          )}
        </>
      )}

      <button
        onClick={() => void reload()}
        className="text-dim hover:text-text mt-4 block text-sm underline-offset-2 transition-colors hover:underline"
      >
        Refresh
      </button>
    </Panel>
  );
}

function Row({ holding, onPick }: { holding: Holding; onPick?: (mint: string) => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(holding.mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="border-line bg-bg rounded-sm border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-mono text-lg tabular-nums">{displayAmount(holding)}</span>
        <div className="flex flex-wrap items-center gap-2">
          {holding.program === "spl" && (
            <span className="border-p/40 text-p rounded border px-1.5 py-0.5 font-mono text-[0.8125rem]">
              USDC
            </span>
          )}
          {holding.multiplier !== 1 && (
            <span className="border-n/40 text-n rounded border px-1.5 py-0.5 font-mono text-[0.8125rem]">
              ×{holding.multiplier} split applied
            </span>
          )}
          {holding.extensions.map((e) => (
            <span
              key={e}
              className="border-line text-dim rounded border px-1.5 py-0.5 font-mono text-[0.8125rem]"
            >
              {e}
            </span>
          ))}
        </div>
      </div>

      <p className="text-dim mt-2 font-mono text-[0.75rem] break-all">{holding.mint}</p>

      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <button
          onClick={() => void copy()}
          className="text-muted hover:text-text underline-offset-2 transition-colors hover:underline"
        >
          {copied ? "Copied" : "Copy address"}
        </button>
        {onPick && (
          <button
            onClick={() => onPick(holding.mint)}
            className="text-accent-ink underline-offset-2 hover:underline"
          >
            Use this one
          </button>
        )}
      </div>
    </li>
  );
}
