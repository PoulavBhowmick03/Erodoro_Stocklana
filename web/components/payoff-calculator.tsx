"use client";

import { useState } from "react";
import { payoffExplanation, splitPayoff, usd } from "@/lib/payoff";

const STRIKE = 500;
/** What the share was worth when it was locked. Without it the slider is a
 *  number with no sign — $250 could be a crash or a bargain. */
const SPOT = 400;
const MIN = 100;
const MAX = 1200;

/** Where a price sits along the slider, as a percentage. */
const at = (v: number) => ((v - MIN) / (MAX - MIN)) * 100;

/**
 * The settlement formula, live.
 *
 * Deliberately opens at $420 — below the strike — because that is the case
 * people misread. The default view should be the one where N expires
 * worthless and the writer eats the whole fall, not the flattering one.
 */
export function PayoffCalculator() {
  const [price, setPrice] = useState(420);
  const { p, n } = splitPayoff(price, STRIKE);

  const pShare = (p / price) * 100;
  const nShare = 100 - pShare;

  const note = payoffExplanation(price, SPOT, STRIKE);

  return (
    <div className="border-line bg-panel rounded-md border p-6 shadow-[0_12px_40px_rgb(10_17_24/0.04)] sm:p-7">
      <div className="flex items-baseline justify-between">
        <label htmlFor="price" className="text-muted text-sm">
          Tokenized equity at expiry{" "}
          <span className="text-dim">· locked at {usd(SPOT)}</span>
        </label>
        <output
          htmlFor="price"
          className="font-mono text-2xl tabular-nums"
          aria-live="polite"
        >
          {usd(price)}
        </output>
      </div>

      <input
        id="price"
        type="range"
        min={MIN}
        max={MAX}
        step={10}
        value={price}
        onChange={(e) => setPrice(Number(e.target.value))}
        className="mt-4 w-full"
      />

      {/* The two prices that give the slider meaning, marked where they fall on
          it rather than described underneath it. */}
      <div className="relative mb-7 h-4 text-[0.8125rem]">
        {([
          [SPOT, "start", "text-dim"],
          [STRIKE, "strike", "text-n"],
        ] as const).map(([v, label, tone]) => (
          <span
            key={label}
            className={`absolute -translate-x-1/2 tracking-[0.1em] uppercase ${tone}`}
            style={{ left: `${at(v)}%` }}
          >
            {label}
          </span>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Leg
          tag="P · Capped equity claim"
          tone="p"
          value={usd(p)}
          caption={
            price > SPOT
              ? `${usd(p - SPOT)} above its ${usd(SPOT)} entry value`
              : price < SPOT
                ? `${usd(SPOT - price)} below its ${usd(SPOT)} entry value`
                : "Equal to its entry value"
          }
        />
        <Leg
          tag="N · Upside claim"
          tone="n"
          value={usd(n)}
          caption="Value above the strike"
        />
      </div>

      <div
        className="border-line mt-5 flex h-1.5 overflow-hidden rounded-full border"
        role="img"
        aria-label={`P holds ${pShare.toFixed(0)} percent of the share, N holds ${nShare.toFixed(0)} percent`}
      >
        <span className="bg-p transition-[width] duration-100" style={{ width: `${pShare}%` }} />
        <span className="bg-n transition-[width] duration-100" style={{ width: `${nShare}%` }} />
      </div>

      <p className="text-dim mt-4 min-h-[3.2em] text-sm">{note}</p>
    </div>
  );
}

function Leg({
  tag,
  tone,
  value,
  caption,
}: {
  tag: string;
  tone: "p" | "n";
  value: string;
  caption: string;
}) {
  return (
    <div className="border-line bg-bg rounded-sm border p-4">
      <div
        className={`font-mono text-[0.8125rem] tracking-[0.12em] uppercase ${
          tone === "p" ? "text-p" : "text-n"
        }`}
      >
        {tag}
      </div>
      <div className="mt-2 font-mono text-2xl tabular-nums">{value}</div>
      <div className="text-dim mt-0.5 text-[0.8rem]">{caption}</div>
    </div>
  );
}
