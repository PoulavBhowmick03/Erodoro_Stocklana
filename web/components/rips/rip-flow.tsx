"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { failureMessage } from "@/components/transaction-progress";
import {
  BUY_MORE_PRICE,
  RIP_PRICE,
  pickLot,
  shortDate,
  totalPaid,
  usd,
  type PoolLot,
  type RipFill,
  type RipPosition,
} from "@/lib/rips/model";
import { DemoBadge, TickerMark, hueStyle, positionMove } from "./bits";
import { useRips } from "./rips-shell";
import { ShareSheet } from "./share-card";

type Pull = { position: RipPosition; fill: RipFill; lot: PoolLot };

type Stage =
  | { kind: "idle" }
  | { kind: "charging"; source: PoolLot["source"] }
  | { kind: "torn"; pull: Pull }
  | { kind: "revealed"; pull: Pull }
  | { kind: "failed"; message: string | null };

type TopUp = { kind: "idle" } | { kind: "busy" } | { kind: "done"; added: number } | { kind: "failed"; message: string };

/** Uniform in [0, 1) from the platform's CSPRNG. */
function fairRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * The pull: tap → anticipation → tear → reveal.
 *
 * Under a second end to end when nothing needs signing. A live Rip holds in
 * the anticipation state while the wallet asks for approval -- the shake is
 * the waiting indicator -- and tears the instant the purchase is confirmed.
 * Which lot was pulled is decided before signing but never shown until the
 * fill is real.
 */
export function useRipFlow() {
  const { lots, buy, mode } = useRips();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const busy = useRef(false);

  const rip = useCallback(async () => {
    if (busy.current) return;
    const lot = pickLot(lots, fairRandom());
    if (!lot) return;
    busy.current = true;
    setStage({ kind: "charging", source: lot.source });
    const started = performance.now();
    const result = await buy.buy(lot, RIP_PRICE, "rip");
    // Enough anticipation to register, never so much that it drags.
    const held = performance.now() - started;
    if (held < 520) await wait(520 - held);
    if (!result.ok) {
      busy.current = false;
      setStage({ kind: "failed", message: result.reason });
      return;
    }
    const pull = { position: result.position, fill: result.fill, lot };
    setStage({ kind: "torn", pull });
    await wait(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320);
    setStage({ kind: "revealed", pull });
    busy.current = false;
  }, [lots, buy]);

  const close = useCallback(() => {
    if (!busy.current) setStage({ kind: "idle" });
  }, []);

  return { stage, rip, close, mode };
}

export function RipOverlay({
  stage,
  onRipAgain,
  onClose,
}: {
  stage: Stage;
  onRipAgain: () => void;
  onClose: () => void;
}) {
  const { buy, lots, positions, marks } = useRips();
  const [share, setShare] = useState(false);
  const [topUp, setTopUp] = useState<TopUp>({ kind: "idle" });
  const pullId = stage.kind === "revealed" ? `${stage.pull.position.id}:${stage.pull.fill.at}` : null;

  useEffect(() => setTopUp({ kind: "idle" }), [pullId]);
  useEffect(() => {
    if (stage.kind === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !share) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage.kind, onClose, share]);

  if (stage.kind === "idle") return null;

  const flowState = buy.flow.flow;
  const activeIndex = flowState?.states.findIndex((s) => s.status === "active") ?? -1;
  const active = activeIndex >= 0 ? flowState?.states[activeIndex] : undefined;
  const waitingOnWallet = active?.status === "active" && active.phase === "approval";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={stage.kind === "revealed" ? "Your Rip" : "Ripping"}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-y-auto bg-[color-mix(in_oklab,var(--color-bg)_88%,transparent)] px-4 py-8 backdrop-blur-md"
    >
      {(stage.kind === "charging" || stage.kind === "torn") && (
        <div className="flex flex-col items-center" aria-live="polite">
          <div className={`rip-pack ${stage.kind === "charging" ? "rip-pack--charging" : "rip-pack--torn"}`}>
            <div className="rip-pack__strip" />
            <div className="flex h-full flex-col items-center justify-center gap-2 pt-8">
              <span className="font-display text-[3.4rem] leading-none font-bold tracking-[-0.05em]">RIP</span>
              <span className="font-display text-xl font-semibold opacity-85">$1</span>
            </div>
          </div>
          <p className="text-muted mt-8 h-6 text-sm">
            {stage.kind === "torn"
              ? ""
              : stage.source === "demo"
                ? "Pulling…"
                : waitingOnWallet
                  ? "Approve in your wallet"
                  : flowState && activeIndex >= 0
                    ? `${flowState.steps[activeIndex].label}…`
                    : "Finding your move…"}
          </p>
        </div>
      )}

      {stage.kind === "failed" && (
        <div className="bg-panel border-line rip-fade-up w-full max-w-sm rounded-3xl border p-6 text-center">
          <p className="font-display text-2xl font-semibold tracking-[-0.03em]">
            {flowState?.halted?.failure.kind === "cancelled" ? "No Rip this time" : "That Rip didn’t go through"}
          </p>
          <p className="text-muted mt-3 text-sm leading-6">
            {flowState?.halted ? failureMessage(flowState.halted.failure) : stage.message}
          </p>
          <p className="text-dim mt-2 text-xs">Nothing was bought unless it appears in My Rips.</p>
          <div className="mt-6 grid gap-2">
            <button type="button" className="rip-cta h-14 text-lg" onClick={onRipAgain}>
              Try again — $1
            </button>
            <button type="button" className="text-muted hover:text-text py-2 text-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}

      {stage.kind === "revealed" && (() => {
        const { position: snapshot, fill, lot } = stage.pull;
        const position = positions.find((p) => p.id === snapshot.id) ?? snapshot;
        const mark = marks.get(position.id);
        const move = positionMove(position);
        const liveLot = lots.find((l) => l.id === lot.id);
        const canTopUp = !!liveLot && liveLot.availableUsd >= BUY_MORE_PRICE;
        const value = mark ? (mark.value * fill.qty) / Math.max(1e-12, position.fills.reduce((s, f) => s + f.qty, 0)) : fill.paid;
        const doTopUp = async () => {
          if (!liveLot) return;
          setTopUp({ kind: "busy" });
          const r = await buy.buy(liveLot, BUY_MORE_PRICE, "buy");
          setTopUp(r.ok ? { kind: "done", added: r.fill.paid } : { kind: "failed", message: r.reason });
        };
        return (
          <div className="relative flex w-full max-w-sm flex-col items-center" style={hueStyle(position.symbol)}>
            <div className="rip-burst" aria-hidden />
            <div className="rip-card rip-reveal-card relative w-full p-6 text-center shadow-[var(--shadow-pop)]">
              <p className="text-dim text-xs font-semibold tracking-[0.22em] uppercase">You pulled</p>
              <div className="rip-reveal-ticker mt-5 flex flex-col items-center">
                <TickerMark symbol={position.symbol} size={64} />
                <p className="text-muted mt-3 text-base font-medium">{position.name}</p>
                <p className="font-display mt-1 text-[4.25rem] leading-[0.95] font-bold tracking-[-0.06em]">
                  {position.symbol} <span className="text-p">↑</span>
                </p>
                {move && (
                  <p className="font-display text-p mt-1 text-3xl font-semibold tracking-[-0.03em]">UP {move}</p>
                )}
                <p className="text-dim mt-2 text-sm font-semibold tracking-[0.18em] uppercase">
                  {position.termDays} days
                </p>
              </div>
              <dl className="border-line/70 rip-fade-up mt-6 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-4 text-left text-[0.8125rem] [animation-delay:200ms]">
                <dt className="text-dim">Bought</dt>
                <dd className="text-right tabular-nums">{usd(fill.paid)}</dd>
                <dt className="text-dim">Position</dt>
                <dd className="text-right">
                  {position.symbol} upside above {usd(position.strike)}
                </dd>
                <dt className="text-dim">Expires</dt>
                <dd className="text-right">{shortDate(position.expiryTs)}</dd>
                <dt className="text-dim">Current value</dt>
                <dd className="text-right tabular-nums">{usd(value)}</dd>
              </dl>
              {lot.source === "demo" && <DemoBadge className="mt-4" />}
            </div>

            <div className="rip-fade-up mt-5 grid w-full gap-2.5 [animation-delay:260ms]">
              <button type="button" className="rip-cta h-16 text-2xl" onClick={onRipAgain}>
                RIP AGAIN — $1
              </button>
              {topUp.kind === "done" ? (
                <p className="border-p/40 text-p rounded-full border py-3.5 text-center text-sm font-medium">
                  Added {usd(topUp.added)} · you hold {usd(totalPaid(position))} of {position.symbol} ↑
                </p>
              ) : (
                <button
                  type="button"
                  disabled={!canTopUp || topUp.kind === "busy"}
                  onClick={() => void doTopUp()}
                  aria-describedby={!canTopUp ? "topup-why" : undefined}
                  title={!canTopUp ? `Less than $${BUY_MORE_PRICE} of this position is left in the pool.` : undefined}
                  className="border-text hover:bg-text hover:text-bg h-14 rounded-full border-2 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-current"
                >
                  {topUp.kind === "busy" ? "Buying…" : `Buy $${BUY_MORE_PRICE} more ${position.symbol} UP`}
                </button>
              )}
              {!canTopUp && (
                <p id="topup-why" className="text-dim text-center text-xs">
                  Less than ${BUY_MORE_PRICE} of this position is left in the pool.
                </p>
              )}
              {topUp.kind === "failed" && (
                <p className="text-danger text-center text-xs">
                  {buy.flow.flow?.halted ? failureMessage(buy.flow.flow.halted.failure) : topUp.message}
                </p>
              )}
              <div className="mt-1 flex items-center justify-center gap-5 text-sm">
                <button type="button" onClick={() => setShare(true)} className="text-text font-medium underline-offset-4 hover:underline">
                  Share
                </button>
                <Link href={`/rips/position?id=${encodeURIComponent(position.id)}`} className="text-muted hover:text-text">
                  Details
                </Link>
                <button type="button" onClick={onClose} className="text-muted hover:text-text">
                  Done
                </button>
              </div>
            </div>
            {share && (
              <ShareSheet
                subject={{ symbol: position.symbol, move, termDays: position.termDays, demo: position.source === "demo" }}
                onClose={() => setShare(false)}
              />
            )}
            <span className="sr-only" aria-live="assertive">
              You pulled {position.name}, {position.symbol} up {move}, {position.termDays} days. Worth {usd(value)}.
            </span>
          </div>
        );
      })()}
    </div>
  );
}
