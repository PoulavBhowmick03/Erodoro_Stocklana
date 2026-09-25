"use client";

import { useId, useState } from "react";
import { splitPayoff, usd } from "@/lib/payoff";

/** One token's claim values, assuming full collateral and unchanged multiplier. */
export function StrategyPayoff({
  tokenSpot,
  tokenCap,
  premium,
}: {
  tokenSpot: number;
  tokenCap: number;
  premium: number | null;
}) {
  const id = useId();
  const [percent, setPercent] = useState(100);
  const max = Math.max(tokenSpot, tokenCap) * 2;
  const maxPercent = Math.floor((max / tokenSpot) * 100);
  const selectedPercent = Math.min(percent, maxPercent);
  const price = (tokenSpot * selectedPercent) / 100;
  const { p, n } = splitPayoff(price, tokenCap);
  const cash = premium ?? 0;
  const top = max + cash;
  const x = (value: number) => 45 + (value / max) * 390;
  const y = (value: number) => 195 - (value / top) * 160;
  return (
    <div className="border-line mt-5 border-t pt-5">
      <h3 className="font-medium">What happens at expiry?</h3>
      <p className="text-dim mt-1 text-xs">
        Illustration per token, assuming full collateral and an unchanged
        multiplier. Fees and payout rounding are excluded.
      </p>
      <svg
        viewBox="0 0 460 235"
        className="mt-3 w-full"
        role="img"
        aria-labelledby={`${id}-chart`}
      >
        <title id={`${id}-chart`}>
          Capped stock claim{" "}
          {premium === null ? "without premium" : "plus quoted premium"} versus
          holding one token
        </title>
        <path
          d="M45 25 V195 H435"
          fill="none"
          stroke="currentColor"
          opacity="0.3"
        />
        <path
          d={`M${x(0)} ${y(0)} L${x(max)} ${y(max)}`}
          fill="none"
          stroke="currentColor"
          strokeDasharray="5 5"
          opacity="0.4"
        />
        <path
          d={`M${x(0)} ${y(cash)} L${x(tokenCap)} ${y(tokenCap + cash)} L${x(max)} ${y(tokenCap + cash)}`}
          fill="none"
          stroke="var(--color-p)"
          strokeWidth="3"
        />
        <circle cx={x(price)} cy={y(p + cash)} r="4" fill="var(--color-p)" />
        <text x="45" y="17" fontSize="11" fill="currentColor">
          Position value (USD)
        </text>
        <text x="45" y="212" fontSize="10" fill="currentColor">
          $0
        </text>
        <text
          x="435"
          y="212"
          textAnchor="end"
          fontSize="10"
          fill="currentColor"
        >
          {usd(max, 2)}
        </text>
        <text
          x="235"
          y="230"
          textAnchor="middle"
          fontSize="11"
          fill="currentColor"
        >
          Token value at expiry (USD)
        </text>
      </svg>
      <p className="text-dim text-xs">
        Solid: capped claim{" "}
        {premium === null ? "(premium unavailable)" : "+ quoted premium"}.
        Dashed: hold the token.
      </p>
      <label htmlFor={id} className="mt-4 block text-sm">
        Token value at expiry:{" "}
        <output className="font-mono" htmlFor={id}>
          {usd(price, 2)}
        </output>
      </label>
      <input
        id={id}
        type="range"
        min="0"
        max={maxPercent}
        step="1"
        value={selectedPercent}
        onChange={(event) => setPercent(Number(event.target.value))}
        className="mt-2 w-full"
      />
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm" aria-live="polite">
        <div>
          <dt className="text-muted">Capped stock claim</dt>
          <dd className="font-mono">{usd(p, 2)}</dd>
        </div>
        <div>
          <dt className="text-muted">Upside surrendered</dt>
          <dd className="font-mono">{usd(n, 2)}</dd>
        </div>
        <div>
          <dt className="text-muted">Quoted premium</dt>
          <dd className="font-mono">
            {premium === null ? "Unavailable" : usd(premium, 2)}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Claim + premium</dt>
          <dd className="font-mono">
            {premium === null ? "Unavailable" : usd(p + premium, 2)}
          </dd>
        </div>
      </dl>
      <p className="text-muted mt-3 text-sm">
        Stock losses remain yours. Below the cap you retain stock gains; above
        it, further gains go to the upside holder. A filled premium is retained
        in either case.
      </p>
      <p className="text-dim mt-2 text-xs">
        Claims redeem in collateral tokens. USD values illustrate the payoff,
        not a cash settlement promise.
      </p>
    </div>
  );
}
