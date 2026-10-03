import type { CSSProperties } from "react";
import { moveLabel, movePct, type RipPosition } from "@/lib/rips/model";

/** A stable hue per symbol, so SOL is always the same colour everywhere. */
export function hueFor(symbol: string) {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function hueStyle(symbol: string): CSSProperties {
  return { ["--rip-hue" as string]: `oklch(0.6 0.16 ${hueFor(symbol)})` };
}

/**
 * The ticker as a mark. There are no licensed logos in this build, so each
 * asset gets a monogram in its own hue -- recognisable at a glance and honest
 * about not being the issuer's brand.
 */
export function TickerMark({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const label = symbol.replace(/x$/, "").slice(0, symbol.length > 4 ? 3 : 4);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-display font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * (label.length > 3 ? 0.27 : 0.33),
        background: `oklch(0.46 0.15 ${hueFor(symbol)})`,
        letterSpacing: "-0.02em",
      }}
    >
      {label}
    </span>
  );
}

/** "↑ +5%": the move the claim is pegged to. Always up; see `lib/rips/model`. */
export function MoveTag({ strike, spot, className = "" }: { strike: number; spot: number | null; className?: string }) {
  const label = moveLabel(movePct(strike, spot));
  return (
    <span className={className}>
      <span aria-label="up">↑</span>
      {label && <> {label}</>}
    </span>
  );
}

export function positionMove(p: RipPosition) {
  return moveLabel(movePct(p.strike, p.spotAtRip));
}

export function DemoBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`border-n/40 text-n inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium tracking-wide uppercase ${className}`}
    >
      Demo · simulated
    </span>
  );
}
