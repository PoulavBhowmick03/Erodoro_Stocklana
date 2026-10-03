"use client";

import Link from "next/link";
import { useState } from "react";
import { pctChange, signedPct, totalPaid, usd } from "@/lib/rips/model";
import { DemoBadge } from "./bits";
import { RipCard } from "./rip-card";
import { useRips } from "./rips-shell";

type Sort = "recent" | "value" | "expiry";

/**
 * Everything ripped, as cards. The reason to come back is on every card:
 * what it is worth now and how long it has left.
 */
export function MyRips() {
  const { positions, marks, now, mode } = useRips();
  const [sort, setSort] = useState<Sort>("recent");

  const total = positions.reduce(
    (acc, p) => {
      acc.paid += totalPaid(p);
      acc.value += marks.get(p.id)?.value ?? totalPaid(p);
      return acc;
    },
    { paid: 0, value: 0 },
  );
  const active = positions.filter((p) => p.expiryTs > now);
  const expired = positions.filter((p) => p.expiryTs <= now);
  const order = (list: typeof positions) =>
    [...list].sort((a, b) =>
      sort === "value"
        ? (marks.get(b.id)?.value ?? 0) - (marks.get(a.id)?.value ?? 0)
        : sort === "expiry"
          ? a.expiryTs - b.expiryTs
          : Math.max(...b.fills.map((f) => f.at)) - Math.max(...a.fills.map((f) => f.at)),
    );
  const change = pctChange(total.value, total.paid);

  return (
    <div className="pt-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.05em]">My Rips</h1>
          {mode === "demo" && <DemoBadge className="mt-2" />}
        </div>
        {positions.length > 0 && (
          <div className="text-right">
            <p className="font-display text-3xl font-semibold tracking-[-0.04em] tabular-nums">{usd(total.value)}</p>
            <p className="text-sm tabular-nums">
              <span className={change >= 0 ? "text-p" : "text-danger"}>{signedPct(change)}</span>
              <span className="text-dim"> on {usd(total.paid)}</span>
            </p>
          </div>
        )}
      </div>

      {positions.length === 0 ? (
        <div className="border-line mt-10 rounded-3xl border border-dashed p-10 text-center">
          <p className="font-display text-2xl font-semibold tracking-[-0.03em]">No Rips yet</p>
          <p className="text-muted mt-2 text-sm">Spend $1, pull a move, and watch what it does.</p>
          <Link href="/market-rip" className="rip-cta mt-6 h-14 px-10 text-xl">
            RIP $1
          </Link>
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="Sort" className="mt-6 flex gap-2 text-[0.8125rem]">
            {(
              [
                ["recent", "Recent"],
                ["value", "Value"],
                ["expiry", "Expiring soon"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={sort === k}
                onClick={() => setSort(k)}
                className={`rounded-full border px-3 py-1 transition-colors ${sort === k ? "border-text bg-text text-bg" : "border-line text-muted hover:text-text"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {order(active).map((p) => (
              <RipCard key={p.id} position={p} mark={marks.get(p.id)} now={now} />
            ))}
          </div>
          {expired.length > 0 && (
            <>
              <h2 className="text-dim mt-10 text-xs font-semibold tracking-[0.2em] uppercase">Expired</h2>
              <div className="mt-3 grid grid-cols-2 gap-3 opacity-80 sm:grid-cols-3">
                {order(expired).map((p) => (
                  <RipCard key={p.id} position={p} mark={marks.get(p.id)} now={now} />
                ))}
              </div>
            </>
          )}
          <div className="mt-10 text-center">
            <Link href="/market-rip" className="rip-cta h-14 px-10 text-xl">
              RIP $1
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
