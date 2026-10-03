"use client";

import Link from "next/link";
import { pctChange, ripCount, signedPct, timeLeft, totalPaid, trackedQty, untrackedQty, usd, type RipPosition } from "@/lib/rips/model";
import type { Mark } from "@/lib/rips/use-rips";
import { TickerMark, hueStyle, positionMove } from "./bits";

/**
 * A position as a card. Level 1 only: what it is, what it is worth, how it is
 * doing, how long it has. Everything else is one tap away.
 */
export function RipCard({
  position,
  mark,
  now,
  compact = false,
}: {
  position: RipPosition;
  mark: Mark | undefined;
  now: number;
  compact?: boolean;
}) {
  const paid = totalPaid(position);
  const value = mark?.value ?? paid;
  const costKnown = trackedQty(position) > 0;
  const change = pctChange(mark?.trackedValue ?? paid, paid);
  const rips = ripCount(position);
  const elsewhere = untrackedQty(position) > 1e-9;
  // With no bid and no known cost there is nothing honest to show as a value.
  const valueLabel = mark?.marked === "cost" && !costKnown ? "—" : usd(value);
  const up = change > 0.5;
  const down = change < -0.5;
  const left = timeLeft(position.expiryTs, now);
  const move = positionMove(position);
  return (
    <Link
      href={`/rips/position?id=${encodeURIComponent(position.id)}`}
      className={`rip-card block ${compact ? "w-[10.5rem] shrink-0 p-4" : "p-5"}`}
      style={hueStyle(position.symbol)}
      aria-label={`${position.symbol} up ${move}, worth ${valueLabel === "—" ? "unknown" : valueLabel}, ${costKnown ? signedPct(change) : "cost unknown"}, ${left}`}
    >
      <div className="flex items-center justify-between gap-2">
        <TickerMark symbol={position.symbol} size={compact ? 30 : 36} />
        <span className="text-dim text-right text-[0.75rem] leading-4 tabular-nums">
          {position.termDays > 0 ? `${position.termDays}D` : ""}
          {rips > 1 && <span className="block">{rips} Rips</span>}
        </span>
      </div>
      <p className={`font-display mt-3 leading-none font-semibold tracking-[-0.04em] ${compact ? "text-xl" : "text-2xl"}`}>
        {position.symbol} <span className="text-p">↑</span>
        <span className="text-muted ml-1 text-[0.7em] font-medium">{move}</span>
      </p>
      <p className={`font-display mt-4 leading-none font-semibold tracking-[-0.04em] tabular-nums ${compact ? "text-[1.6rem]" : "text-[2rem]"}`}>
        {valueLabel}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[0.8125rem] tabular-nums">
        <span className={!costKnown ? "text-dim" : up ? "text-p font-medium" : down ? "text-danger font-medium" : "text-muted"}>
          {costKnown ? signedPct(change) : "Cost unknown"}
        </span>
        <span className={left === "Expired" || left.endsWith("h left") || left.endsWith("m left") ? "text-accent-ink" : "text-dim"}>
          {left}
        </span>
      </div>
      {mark?.marked === "cost" && (
        <p className="text-dim mt-2 text-[0.6875rem] leading-4">No bid yet · {costKnown ? "shown at cost" : "value unknown"}</p>
      )}
      {elsewhere && (
        <p className="text-dim mt-2 text-[0.6875rem] leading-4">Includes claims bought on another device</p>
      )}
    </Link>
  );
}
