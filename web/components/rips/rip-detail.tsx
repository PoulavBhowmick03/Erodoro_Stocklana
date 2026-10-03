"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { AddressLink } from "@/components/ui";
import { failureMessage } from "@/components/transaction-progress";
import { NETWORK } from "@/lib/network-config";
import {
  explainPosition,
  pctChange,
  shortDate,
  signedPct,
  timeLeft,
  totalPaid,
  totalQty,
  upsideAtExpiry,
  usd,
  type RipPosition,
} from "@/lib/rips/model";
import { DemoBadge, TickerMark, hueStyle, positionMove } from "./bits";
import { useRips } from "./rips-shell";
import { ShareSheet } from "./share-card";

const AMOUNTS = [1, 5, 20];

/**
 * What the claim pays at expiry across underlying prices, with today's price
 * and the break-even marked. One line, three markers: enough to see why the
 * value moved without reading a word.
 */
function PayoffChart({ position, spot }: { position: RipPosition; spot: number | null }) {
  const qty = totalQty(position);
  const paid = totalPaid(position);
  const k = position.strike;
  const breakeven = k + paid / Math.max(qty, 1e-12);
  const lo = Math.min(k * 0.88, (spot ?? k) * 0.97);
  const hi = Math.max(breakeven * 1.08, k * 1.15, (spot ?? k) * 1.03);
  const W = 320;
  const H = 150;
  const pad = { l: 8, r: 8, t: 14, b: 26 };
  const maxV = upsideAtExpiry(hi, k) * qty;
  const x = (p: number) => pad.l + ((p - lo) / (hi - lo)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / Math.max(maxV, 1e-12)) * (H - pad.t - pad.b);
  const path = `M ${x(lo)} ${y(0)} L ${x(k)} ${y(0)} L ${x(hi)} ${y(maxV)}`;
  return (
    <figure className="mt-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Value at expiry: zero below ${usd(k)}, rising above it. Break-even at ${usd(breakeven)}.`}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--color-line)" />
        <line x1={pad.l} x2={W - pad.r} y1={y(paid)} y2={y(paid)} stroke="var(--color-line)" strokeDasharray="2 4" />
        <text x={W - pad.r} y={y(paid) - 4} textAnchor="end" fontSize="9" fill="var(--color-dim)">paid {usd(paid)}</text>
        <path d={path} fill="none" stroke="var(--rip-hue)" strokeWidth="3" strokeLinejoin="round" />
        <line x1={x(k)} x2={x(k)} y1={pad.t} y2={y(0)} stroke="var(--color-dim)" strokeDasharray="3 3" />
        <text x={x(k)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-muted)">{usd(k)}</text>
        {spot !== null && spot >= lo && spot <= hi && (
          <g>
            <circle cx={x(spot)} cy={y(upsideAtExpiry(spot, k) * qty)} r="5" fill="var(--color-text)" />
            <text x={x(spot)} y={pad.t - 2} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-text)">now</text>
            <line x1={x(spot)} x2={x(spot)} y1={pad.t + 2} y2={y(0)} stroke="var(--color-text)" strokeOpacity="0.35" />
          </g>
        )}
      </svg>
      <figcaption className="text-dim mt-1 flex justify-between text-[0.75rem]">
        <span>Value at expiry by {position.symbol} price</span>
        <span>Break-even {usd(breakeven)}</span>
      </figcaption>
    </figure>
  );
}

export function RipDetail() {
  const params = useSearchParams();
  const id = params.get("id");
  const { positions, marks, now, lots, buy } = useRips();
  const position = positions.find((p) => p.id === id);
  const [amount, setAmount] = useState(5);
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; added: number } | { kind: "failed"; message: string }>({ kind: "idle" });
  const [share, setShare] = useState(false);

  if (!position) {
    return (
      <div className="pt-16 text-center">
        <p className="font-display text-2xl font-semibold">This Rip isn’t here</p>
        <p className="text-muted mt-2 text-sm">
          It may belong to another wallet, or to the {id?.startsWith("demo:") ? "demo" : "live"} pool you aren’t viewing.
        </p>
        <Link href="/rips" className="text-accent-ink mt-6 inline-block text-sm font-medium underline underline-offset-4">
          Back to My Rips
        </Link>
      </div>
    );
  }

  const mark = marks.get(position.id);
  const paid = totalPaid(position);
  const qty = totalQty(position);
  const value = mark?.value ?? paid;
  const change = pctChange(value, paid);
  const spot = mark?.spot ?? null;
  const move = positionMove(position);
  const expired = position.expiryTs <= now;
  const lot = lots.find((l) => l.id === position.lotId);
  const canBuy = !expired && !!lot && lot.availableUsd >= amount;
  const buyWhy = expired
    ? "This position has expired."
    : !lot
      ? "This exact position isn’t in the pool right now."
      : lot.availableUsd < amount
        ? `Only ${usd(lot.availableUsd)} of it is left in the pool.`
        : null;

  const topUp = async () => {
    if (!lot) return;
    setState({ kind: "busy" });
    const r = await buy.buy(lot, amount, "buy");
    setState(r.ok ? { kind: "done", added: r.fill.paid } : { kind: "failed", message: r.reason });
  };

  const distance = spot ? ((position.strike - spot) / spot) * 100 : null;

  return (
    <div className="pt-6" style={hueStyle(position.symbol)}>
      <Link href="/rips" className="text-muted hover:text-text text-sm">
        ← My Rips
      </Link>

      {/* Level 1 */}
      <section className="rip-card mt-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <TickerMark symbol={position.symbol} size={52} />
            <div>
              <p className="font-display text-[2rem] leading-none font-bold tracking-[-0.05em] sm:text-[2.4rem]">
                {position.symbol} <span className="text-p">UP</span> {move}
              </p>
              <p className="text-muted mt-1 text-sm">
                {position.name} · {position.termDays}D
              </p>
            </div>
          </div>
          <button type="button" onClick={() => setShare(true)} className="border-line hover:border-text shrink-0 rounded-full border px-3 py-1.5 text-sm">
            Share
          </button>
        </div>
        <div className="mt-6 flex items-end justify-between gap-4">
          <div>
            <p className="font-display text-5xl font-semibold tracking-[-0.05em] tabular-nums">{usd(value)}</p>
            <p className="mt-1 text-sm tabular-nums">
              <span className={change > 0.5 ? "text-p font-medium" : change < -0.5 ? "text-danger font-medium" : "text-muted"}>
                {signedPct(change)}
              </span>
              <span className="text-dim"> · paid {usd(paid)}</span>
            </p>
          </div>
          <p className={`text-right text-sm font-medium ${expired ? "text-accent-ink" : "text-muted"}`}>{timeLeft(position.expiryTs, now)}</p>
        </div>
        {position.source === "demo" && <DemoBadge className="mt-4" />}
      </section>

      {/* Level 2 */}
      <section className="mt-6">
        <p className="font-display text-xl leading-snug font-medium tracking-[-0.02em]">
          You own exposure to {position.name} gains above {usd(position.strike)} until {shortDate(position.expiryTs)}.
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          {[
            ["Price now", spot ? usd(spot) : "—"],
            ["Exposure starts", usd(position.strike)],
            [
              "Needs to rise",
              distance === null ? "—" : distance <= 0 ? "Already above" : `${distance.toFixed(1)}%`,
            ],
            ["Expires", `${shortDate(position.expiryTs)} · ${timeLeft(position.expiryTs, now)}`],
            ["Paid", usd(paid)],
            ["Worth now", `${usd(value)}${mark?.marked === "cost" ? " (no bid)" : ""}`],
          ].map(([k, v]) => (
            <div key={k} className="border-line/70 bg-panel rounded-2xl border px-4 py-3">
              <dt className="text-dim text-xs">{k}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <PayoffChart position={position} spot={spot} />
      </section>

      {/* The one action */}
      <section className="border-line/70 bg-panel mt-8 rounded-3xl border p-5">
        {expired ? (
          <p className="text-muted text-sm leading-6">
            This position has expired.{" "}
            {position.source === "live" ? (
              <>
                Once the series settles, redeem it in{" "}
                <Link href="/portfolio" className="text-text underline underline-offset-2">Portfolio</Link>.
              </>
            ) : (
              "Demo positions settle on paper only."
            )}
          </p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Amount" className="flex gap-2">
              {AMOUNTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={amount === a}
                  onClick={() => {
                    setAmount(a);
                    setState({ kind: "idle" });
                  }}
                  className={`flex-1 rounded-full border py-2 text-sm font-semibold transition-colors ${amount === a ? "border-text bg-text text-bg" : "border-line text-muted hover:text-text"}`}
                >
                  ${a}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!canBuy || state.kind === "busy"}
              onClick={() => void topUp()}
              aria-describedby={buyWhy ? "buy-why" : undefined}
              title={buyWhy ?? undefined}
              className="rip-cta mt-3 h-16 w-full text-xl"
            >
              {state.kind === "busy" ? "Buying…" : `BUY $${amount} MORE ${position.symbol} UP`}
            </button>
            {buyWhy && (
              <p id="buy-why" className="text-dim mt-2 text-center text-xs">
                {buyWhy}
              </p>
            )}
            {state.kind === "done" && (
              <p className="text-p mt-3 text-center text-sm font-medium" role="status">
                Added {usd(state.added)} to this position.
              </p>
            )}
            {state.kind === "failed" && (
              <p className="text-danger mt-3 text-center text-sm" role="alert">
                {buy.flow.flow?.halted ? failureMessage(buy.flow.flow.halted.failure) : state.message}
              </p>
            )}
          </>
        )}
      </section>

      {/* Level 3, closed by default */}
      <details className="border-line/70 mt-8 border-t pt-5 text-sm">
        <summary className="cursor-pointer font-medium">How it works</summary>
        <div className="text-muted mt-3 space-y-2 leading-6">
          <p>{explainPosition(position)}</p>
          <p>
            At expiry, every {position.symbol} point above {usd(position.strike)} is worth $1 per claim you hold. You hold{" "}
            {qty.toLocaleString("en-US", { maximumFractionDigits: 6 })} claims, so if {position.symbol} ends at{" "}
            {usd(position.strike * 1.1)}, this pays {usd(upsideAtExpiry(position.strike * 1.1, position.strike) * qty)}.
          </p>
          <p>
            If {position.symbol} ends at or below {usd(position.strike)}, it pays nothing. There is no floor. Before expiry
            the value moves with the price and the time left.
          </p>
        </div>
      </details>

      <details className="border-line/70 mt-4 border-t pt-5 text-sm">
        <summary className="cursor-pointer font-medium">Full details</summary>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-dim">Instrument</dt>
          <dd>N (upside) claim — pays max(0, settlement price − strike) per claim</dd>
          <dt className="text-dim">Underlying</dt>
          <dd>{position.name} ({position.symbol})</dd>
          <dt className="text-dim">Strike</dt>
          <dd className="tabular-nums">{usd(position.strike, 4)}</dd>
          <dt className="text-dim">Expiry</dt>
          <dd>{new Date(position.expiryTs * 1000).toUTCString()}</dd>
          <dt className="text-dim">Quantity</dt>
          <dd className="tabular-nums">{qty.toLocaleString("en-US", { maximumFractionDigits: 9 })}</dd>
          <dt className="text-dim">Average price</dt>
          <dd className="tabular-nums">{usd(paid / Math.max(qty, 1e-12), 6)} per claim</dd>
          <dt className="text-dim">Marked at</dt>
          <dd>
            {mark?.marked === "bid"
              ? "Best bid on the live order book"
              : mark?.marked === "cost"
                ? "Cost — nobody is bidding right now"
                : "Simulation model (demo)"}
          </dd>
          <dt className="text-dim">Settlement</dt>
          <dd>
            {position.source === "live"
              ? "Settled by the series against its approved oracle after expiry; redeem from Portfolio."
              : "Demo only — nothing settles on chain."}
          </dd>
          <dt className="text-dim">Network</dt>
          <dd>{position.source === "live" ? `Solana ${NETWORK.label} · orders on MagicBlock` : "None (simulated)"}</dd>
        </dl>
        {position.series && (
          <div className="mt-4">
            <AddressLink label="Series" address={position.series} />
          </div>
        )}
        <h3 className="text-dim mt-5 text-xs font-semibold tracking-[0.16em] uppercase">Purchases</h3>
        <ul className="mt-2 divide-y divide-[var(--color-line)]">
          {position.fills.map((f) => (
            <li key={f.at} className="flex items-center justify-between gap-3 py-2 tabular-nums">
              <span>
                {f.kind === "rip" ? "Rip" : "Buy more"} · {new Date(f.at).toLocaleString()}
              </span>
              <span className="flex items-center gap-3">
                {usd(f.paid)}
                {f.signature && (
                  <span className="text-dim font-mono text-xs" title="MagicBlock transaction signature">
                    {f.signature.slice(0, 6)}…
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {share && (
        <ShareSheet subject={{ symbol: position.symbol, move, termDays: position.termDays, demo: position.source === "demo" }} onClose={() => setShare(false)} />
      )}
    </div>
  );
}
