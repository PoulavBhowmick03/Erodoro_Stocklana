"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { BookLevel, BookSide } from "@/lib/order-book-levels";
import { claimLabel, orderMaximum, orderPreview, sizedPercentage } from "@/lib/trading-ux";
import { formatDate } from "@/lib/format";
import { AmountInput, Button, InfoDot, LiveDot, Segmented, Ticking } from "./ui";

const VISIBLE_LEVELS = 12;
const PRICE_HISTORY_LIMIT = 2_000;
const shown = (value: number, minimumFractionDigits = 0) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits,
    maximumFractionDigits: 6,
  });

type PriceObservation = {
  at: number;
  bid?: number;
  ask?: number;
  mid: number;
};

type ChartRange = "1H" | "1D" | "1W" | "ALL";

/**
 * A real-time price chart derived from executable book quotes.
 *
 * It deliberately says "indicative": the midpoint is not a completed trade.
 * Observations remain in memory for the current visit. An empty market stays
 * visibly empty instead of drawing a fake line; durable fill history can
 * replace this adapter without storing protocol state in the browser.
 *
 * With no observations it collapses to a single strip rather than holding open
 * a 16rem plot of nothing. Reserving that much space for absent data was the
 * largest single block of emptiness on the screen, and it pushed the book —
 * the thing people came for — below the fold.
 */
export function MarketPriceChart({
  marketKey,
  bestBid,
  bestAsk,
  baseSymbol,
  quoteSymbol,
}: {
  marketKey: string;
  bestBid?: number;
  bestAsk?: number;
  baseSymbol: string;
  quoteSymbol: string;
}) {
  const [range, setRange] = useState<ChartRange>("1D");
  const [points, setPoints] = useState<PriceObservation[]>([]);

  useEffect(() => {
    setPoints([]);
  }, [marketKey]);

  useEffect(() => {
    if (bestBid === undefined && bestAsk === undefined) return;
    const mid =
      bestBid !== undefined && bestAsk !== undefined
        ? (bestBid + bestAsk) / 2
        : (bestBid ?? bestAsk)!;
    if (!Number.isFinite(mid)) return;

    setPoints((current) => {
      const now = Date.now();
      const last = current.at(-1);
      const next = { at: now, bid: bestBid, ask: bestAsk, mid };
      const sameQuote =
        last !== undefined &&
        last?.bid === next.bid &&
        last?.ask === next.ask &&
        now - last.at < 30_000;
      const updated = sameQuote ? [...current.slice(0, -1), next] : [...current, next];
      return updated.slice(-PRICE_HISTORY_LIMIT);
    });
  }, [bestAsk, bestBid]);

  const visible = useMemo(() => {
    const duration =
      range === "1H"
        ? 60 * 60_000
        : range === "1D"
          ? 24 * 60 * 60_000
          : range === "1W"
            ? 7 * 24 * 60 * 60_000
            : Number.POSITIVE_INFINITY;
    const cutoff = Date.now() - duration;
    return points.filter((point) => point.at >= cutoff);
  }, [points, range]);

  const current = visible.at(-1);

  if (!visible.length) {
    return (
      <section
        data-market-price-chart
        className="border-line bg-bg text-dim mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-[0.8125rem]"
        aria-label={`${baseSymbol} indicative price chart`}
      >
        <span>
          Price history starts with the first quote on {baseSymbol}/{quoteSymbol}.
        </span>
        <span className="font-mono">—</span>
      </section>
    );
  }

  return (
    <section
      data-market-price-chart
      className="border-line bg-bg rise-in mb-3 overflow-hidden rounded-md border"
      aria-label={`${baseSymbol} indicative price chart`}
    >
      <div className="border-line-soft flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[0.8125rem] font-medium">Market price</h4>
          <span className="text-dim text-xs">
            {baseSymbol}/{quoteSymbol}
          </span>
          <InfoDot hint="Indicative midpoint between the best bid and ask. It is not a completed trade." />
        </div>
        <div className="flex items-center gap-3">
          {current && (
            <Ticking
              value={`${shown(current.mid, 2)} ${quoteSymbol}`}
              className="font-mono text-sm tabular-nums"
            />
          )}
          <Segmented
            size="sm"
            label="Chart range"
            value={range}
            onChange={setRange}
            options={[
              { value: "1H" as const, label: "1H" },
              { value: "1D" as const, label: "1D" },
              { value: "1W" as const, label: "1W" },
              { value: "ALL" as const, label: "All" },
            ]}
          />
        </div>
      </div>
      <PricePlot points={visible} quoteSymbol={quoteSymbol} />
    </section>
  );
}

function PricePlot({
  points,
  quoteSymbol,
}: {
  points: PriceObservation[];
  quoteSymbol: string;
}) {
  const width = 720;
  const height = 200;
  const padX = 18;
  const padY = 20;
  const values = points.flatMap((point) =>
    [point.bid, point.ask, point.mid].filter((value): value is number => value !== undefined),
  );
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const margin = Math.max((maximum - minimum) * 0.12, Math.max(maximum, 1) * 0.01);
  const low = Math.max(0, minimum - margin);
  const high = maximum + margin;
  const firstAt = points[0].at;
  const lastAt = points.at(-1)!.at;
  const elapsed = Math.max(lastAt - firstAt, 1);
  const x = (at: number) =>
    points.length === 1 ? width / 2 : padX + ((at - firstAt) / elapsed) * (width - padX * 2);
  const y = (value: number) =>
    padY + ((high - value) / Math.max(high - low, 1e-9)) * (height - padY * 2);
  const line = (field: "bid" | "ask" | "mid") =>
    points
      .map((point) => {
        const value = point[field];
        return value === undefined ? null : `${x(point.at).toFixed(1)},${y(value).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  const area = `${line("mid")} ${x(lastAt).toFixed(1)},${height - padY} ${x(firstAt).toFixed(1)},${height - padY}`;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        role="img"
        aria-label={`Live midpoint price in ${quoteSymbol}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="mid-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2={width}
            y1={height * ratio}
            y2={height * ratio}
            stroke="var(--chart-grid)"
          />
        ))}
        {points.length > 1 && <polygon points={area} fill="url(#mid-fill)" />}
        {points.some((point) => point.bid !== undefined) && (
          <polyline points={line("bid")} fill="none" stroke="var(--color-bid)" strokeOpacity="0.6" strokeWidth="1.5" />
        )}
        {points.some((point) => point.ask !== undefined) && (
          <polyline points={line("ask")} fill="none" stroke="var(--color-ask)" strokeOpacity="0.6" strokeWidth="1.5" />
        )}
        <polyline
          points={line("mid")}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.length === 1 && <circle cx={width / 2} cy={y(points[0].mid)} r="4" fill="var(--color-accent)" />}
        <text x="8" y="14" fill="var(--chart-label)" fontSize="11">
          {high.toFixed(2)}
        </text>
        <text x="8" y={height - 6} fill="var(--chart-label)" fontSize="11">
          {low.toFixed(2)} {quoteSymbol}
        </text>
      </svg>
      <div className="text-dim absolute right-3 bottom-1.5 flex gap-3 text-[0.75rem]">
        <span className="text-accent-ink">● mid</span>
        <span className="text-bid">● bid</span>
        <span className="text-ask">● ask</span>
      </div>
    </div>
  );
}

/**
 * The price-time ladder.
 *
 * Two changes carry most of the weight here. Rows are dense enough that a real
 * book fits on one screen, and an empty book offers the action that fixes it
 * rather than only reporting the absence — on a young market the first trader
 * to arrive is the one who has to post, and "No bids" told them nothing about
 * that.
 */
export function OrderBookLadder<T>({
  asks,
  bids,
  baseSymbol,
  quoteSymbol,
  onSelect,
  onSeed,
  live = false,
}: {
  asks: readonly BookLevel<T>[];
  bids: readonly BookLevel<T>[];
  baseSymbol: string;
  quoteSymbol: string;
  onSelect: (level: BookLevel<T>, side: BookSide) => void;
  /** Offered when a side is empty: start the ticket on that side. */
  onSeed?: (side: BookSide) => void;
  live?: boolean;
}) {
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const spread = bestAsk === undefined || bestBid === undefined ? null : bestAsk - bestBid;
  const visibleAsks = asks.slice(0, VISIBLE_LEVELS);
  const visibleBids = bids.slice(0, VISIBLE_LEVELS);

  return (
    <div data-orderbook-ladder className="border-line bg-panel overflow-hidden rounded-md border">
      <div className="border-line text-dim bg-panel-2/60 grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.9fr)] border-b px-3 py-1.5 text-[0.7rem] tracking-[0.1em] uppercase">
        <span>Price ({quoteSymbol})</span>
        <span className="text-right">Size ({baseSymbol})</span>
        <span className="text-right">Total</span>
      </div>

      <div data-book-side="asks" aria-label="Sell orders">
        {visibleAsks.length ? (
          [...visibleAsks]
            .reverse()
            .map((level) => (
              <DepthRow
                key={`ask-${level.price}`}
                level={level}
                side="ask"
                maximum={visibleAsks.at(-1)?.total ?? 0}
                onSelect={() => onSelect(level, "ask")}
              />
            ))
        ) : (
          <EmptyBookSide side="ask" symbol={baseSymbol} onSeed={onSeed} />
        )}
      </div>

      <div
        data-book-spread
        className="border-line bg-panel-2/60 grid grid-cols-3 items-center border-y px-3 py-2 font-mono text-xs tabular-nums"
      >
        <Metric label="Best ask" value={bestAsk} tone="ask" />
        <div className="text-center">
          <span className="text-dim block font-sans text-[0.7rem] tracking-[0.1em] uppercase">
            Spread
          </span>
          <Ticking
            value={spread === null ? "—" : spread < 0 ? "crossed" : shown(spread, 2)}
            className="inline-block px-1"
          />
        </div>
        <Metric label="Best bid" value={bestBid} tone="bid" align="right" />
      </div>

      <div data-book-side="bids" aria-label="Buy orders">
        {visibleBids.length ? (
          visibleBids.map((level) => (
            <DepthRow
              key={`bid-${level.price}`}
              level={level}
              side="bid"
              maximum={visibleBids.at(-1)?.total ?? 0}
              onSelect={() => onSelect(level, "bid")}
            />
          ))
        ) : (
          <EmptyBookSide side="bid" symbol={baseSymbol} onSeed={onSeed} />
        )}
      </div>

      <p className="border-line-soft text-dim flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[0.75rem]">
        <span>Select a level to prefill the ticket.</span>
        <LiveDot live={live} label={live ? "Live" : "Idle"} />
      </p>
    </div>
  );
}

function DepthRow<T>({
  level,
  side,
  maximum,
  onSelect,
}: {
  level: BookLevel<T>;
  side: BookSide;
  maximum: number;
  onSelect: () => void;
}) {
  const depth = maximum > 0 ? (level.total / maximum) * 100 : 0;
  return (
    <button
      type="button"
      data-book-order={side}
      onClick={onSelect}
      aria-label={`Use ${side} at ${shown(level.price)} for size ${shown(level.size)}`}
      title={`${level.orders.length} order${level.orders.length === 1 ? "" : "s"} at this price · click to prefill`}
      className="border-line-soft hover:bg-panel-2 relative grid w-full grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.9fr)] border-b px-3 py-1 text-left font-mono text-[0.78rem] tabular-nums transition-colors duration-100 last:border-b-0"
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 right-0 transition-[width] duration-300 ease-[var(--ease-ui)] ${
          side === "bid" ? "bg-bid/12" : "bg-ask/12"
        }`}
        style={{ width: `${Math.max(0, Math.min(100, depth))}%` }}
      />
      <span className={`relative font-medium ${side === "bid" ? "text-bid" : "text-ask"}`}>
        {shown(level.price, 2)}
      </span>
      <span className="relative text-right">{shown(level.size)}</span>
      <span className="text-muted relative text-right">{shown(level.total)}</span>
    </button>
  );
}

function Metric({
  label,
  value,
  tone,
  align = "left",
}: {
  label: string;
  value?: number;
  tone: BookSide;
  align?: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : undefined}>
      <span className="text-dim block font-sans text-[0.7rem] tracking-[0.1em] uppercase">
        {label}
      </span>
      <span className={tone === "bid" ? "text-bid" : "text-ask"}>
        {value === undefined ? "—" : shown(value, 2)}
      </span>
    </div>
  );
}

/**
 * An empty side names the action that fills it. A new market has no bids
 * because nobody has posted one yet, and the person reading this is the one who
 * can.
 */
function EmptyBookSide({
  side,
  symbol,
  onSeed,
}: {
  side: BookSide;
  symbol: string;
  onSeed?: (side: BookSide) => void;
}) {
  return (
    <div className="px-3 py-4 text-center">
      <p className="text-dim text-[0.78rem]">
        No {side === "ask" ? "asks" : "bids"} yet
      </p>
      {onSeed && (
        <button
          type="button"
          onClick={() => onSeed(side)}
          className={`mt-1 text-[0.78rem] underline-offset-2 transition-colors hover:underline ${
            side === "ask" ? "text-ask" : "text-bid"
          }`}
        >
          {side === "ask" ? `Post the first ask on ${symbol}` : `Post the first bid on ${symbol}`}
        </button>
      )}
    </div>
  );
}

/**
 * What a trader needs on hand before an order can rest: more of the claim than
 * they hold. Surfaced inside the ticket, at the moment the shortfall exists,
 * with the action that resolves it.
 *
 * The mint step used to be a permanent panel sitting above the ticket, present
 * whether or not it was needed. That put a second, unrelated form between the
 * trader and the button they came to press, and it was showing on every single
 * visit including the ones where the balance was already sufficient.
 */
/**
 * A buyer who cannot pay for the order they composed.
 *
 * Unlike a claim shortfall this cannot be resolved by an instruction the app
 * can build -- the money has to come from somewhere else. On devnet that is the
 * demo mint, and the trip there carries a validated way back so the composed
 * order is still waiting on return. On mainnet there is no funding route to
 * offer, so the requirement is stated and nothing is invented.
 */
export type TicketFunding = {
  shortBy: number;
  symbol: string;
  /** Where to go and get it, when there is somewhere. */
  href?: string;
  action?: string;
  note: string;
};

export type TicketShortfall = {
  deficit: number;
  symbol: string;
  collateralSymbol: string;
  /** Why locking cannot proceed, when it cannot. */
  blocked?: string;
};

export function OrderTicket({
  side,
  onSideChange,
  price,
  onPriceChange,
  size,
  onSizeChange,
  baseSymbol,
  quoteSymbol,
  availableBase,
  availableQuote,
  disabled,
  validation,
  onSubmit,
  status,
  strike,
  expiry,
  shortfall,
  funding,
  outcome,
  approvals,
  busy = false,
  highlight = 0,
}: {
  side: "buy" | "sell";
  onSideChange: (side: "buy" | "sell") => void;
  price: string;
  onPriceChange: (value: string) => void;
  size: string;
  onSizeChange: (value: string) => void;
  baseSymbol: string;
  quoteSymbol: string;
  availableBase: number;
  availableQuote: number;
  disabled: boolean;
  validation?: string;
  onSubmit: () => void;
  status?: ReactNode;
  strike?: number;
  expiry?: number;
  shortfall?: TicketShortfall;
  funding?: TicketFunding;
  /** What the last confirmed order actually did, once the book was read back. */
  outcome?: { message: string; destination: string; kind: "rested" | "partial" | "filled" };
  /** What the wallet is about to ask for, stated before it asks. */
  approvals?: string;
  busy?: boolean;
  /** Bumped when the book prefills the ticket, to flash the fields. */
  highlight?: number;
}) {
  const priceNumber = Number(price);
  const sizeNumber = Number(size);
  const preview = orderPreview({
    side,
    price: priceNumber,
    size: sizeNumber,
    availableBase,
    availableQuote,
  });
  const maximum = orderMaximum({ side, price: priceNumber, availableBase, availableQuote });
  const label = baseSymbol === "P" || baseSymbol === "N" ? claimLabel(baseSymbol) : baseSymbol;
  const complete = priceNumber > 0 && sizeNumber > 0;

  const setPercentage = (percentage: number) => {
    const next = sizedPercentage(maximum, percentage);
    onSizeChange(next > 0 ? next.toFixed(6).replace(/\.?0+$/, "") : "");
  };

  // Ring the fields when a book click writes into them, so the click is
  // visibly connected to its effect. Driven by state rather than a keyframe:
  // an animation that fails to start leaves the highlight painted on forever,
  // and a permanently tinted form looks like a validation error.
  const [flashing, setFlashing] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), 600);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  return (
    <section
      data-tour="place-order"
      className="border-line bg-panel shadow-panel overflow-hidden rounded-md border"
    >
      <div className="p-3.5">
        {/* The side selector says only "Buy"/"Sell": the claim is named
            directly above it and again on the quantity field, and repeating it
            here gave this control the same accessible name as the submit
            button — two different actions a screen reader could not tell
            apart. */}
        <Segmented
          full
          label="Order side"
          value={side}
          onChange={onSideChange}
          options={[
            { value: "buy" as const, label: "Buy", tone: "buy" },
            { value: "sell" as const, label: "Sell", tone: "sell" },
          ]}
        />

        <div
          className={`mt-3.5 space-y-3 rounded-sm transition-shadow duration-500 ease-[var(--ease-ui)] ${
            flashing ? "shadow-[0_0_0_2px_var(--color-accent)]" : "shadow-none"
          }`}
        >
          <AmountInput
            label="Limit price"
            value={price}
            onChange={onPriceChange}
            suffix={quoteSymbol}
            onSubmit={disabled ? undefined : onSubmit}
          />
          <AmountInput
            label="Quantity"
            value={size}
            onChange={onSizeChange}
            suffix={baseSymbol}
            note={`${shown(side === "buy" ? availableQuote : availableBase, 2)} ${side === "buy" ? quoteSymbol : baseSymbol} available`}
            onSubmit={disabled ? undefined : onSubmit}
          />
          <div className="grid grid-cols-4 gap-1" aria-label="Order size percentage">
            {[25, 50, 75, 100].map((percentage) => (
              <button
                key={percentage}
                type="button"
                disabled={maximum <= 0}
                onClick={() => setPercentage(percentage)}
                className="border-line bg-bg text-muted hover:border-text hover:text-text rounded-sm border px-2 py-1.5 font-mono text-[0.75rem] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {percentage === 100 ? "Max" : `${percentage}%`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* The single number the decision turns on, given its own weight. It was
          previously the second row of a seven-row definition list in 12px grey,
          which is not where the headline figure belongs. */}
      <div className="border-line-soft bg-bg border-y px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-dim text-[0.75rem] tracking-[0.1em] uppercase">
            {side === "buy" ? "You pay at most" : "You receive at least"}
          </span>
          <span
            className={`font-mono text-lg tabular-nums ${complete ? (side === "buy" ? "text-bid" : "text-ask") : "text-dim"}`}
          >
            {shown(preview.total, 2)} <span className="text-[0.8rem]">{quoteSymbol}</span>
          </span>
        </div>

        <dl className="text-muted mt-2.5 space-y-1.5 text-[0.78rem]">
          {/* A buy spends quote and a sell spends base, so the label has to
              follow the side. It said "N balance after" above a USDC figure. */}
          <Row
            label={`${side === "buy" ? quoteSymbol : baseSymbol} balance after`}
            value={`${shown(preview.remaining, 2)} ${side === "buy" ? quoteSymbol : baseSymbol}`}
          />
          {side === "buy" && baseSymbol === "N" && strike !== undefined && priceNumber > 0 && (
            <>
              <Row
                label="Break-even at expiry"
                value={`$${shown(strike + priceNumber, 2)}`}
                hint="The collateral price at which this claim returns exactly what you paid."
              />
              <Row
                label="Maximum loss"
                value={`${shown(preview.total, 2)} ${quoteSymbol}`}
                hint="N expires worthless below the strike. You cannot lose more than the purchase price."
              />
            </>
          )}
          {expiry !== undefined && <Row label="Settles" value={formatDate(expiry)} />}
          <Row label="Execution" value="MagicBlock · price-time" />
        </dl>
      </div>

      <div className="p-3.5">
        {/* The shortfall is disclosed, not actioned separately. Locking is the
            first step of the order flow, so the trader agrees to the whole
            sequence once rather than pressing two buttons that look unrelated. */}
        {shortfall && (
          <div className="border-n/35 bg-n/8 rise-in mb-3 rounded-sm border p-3">
            <p className="text-n text-[0.8rem] leading-5">
              This order needs{" "}
              <span className="font-mono font-medium">
                {shown(shortfall.deficit, 4)} {shortfall.symbol}
              </span>{" "}
              more than you hold.{" "}
              {shortfall.blocked
                ? "Locking collateral is not available."
                : `Submitting locks ${shown(shortfall.deficit, 4)} ${shortfall.collateralSymbol} to mint it first.`}
            </p>
            {shortfall.blocked && (
              <p className="text-danger mt-2 text-[0.75rem] leading-5">{shortfall.blocked}</p>
            )}
          </div>
        )}

        {funding && (
          <div className="border-bid/35 bg-bid/8 rise-in mb-3 rounded-sm border p-3">
            <p className="text-bid text-[0.8rem] leading-5">
              This order costs{" "}
              <span className="font-mono font-medium">
                {shown(funding.shortBy, 2)} {funding.symbol}
              </span>{" "}
              more than you hold.
            </p>
            <p className="text-muted mt-1 text-[0.75rem] leading-5">{funding.note}</p>
            {funding.href && funding.action && (
              <a
                href={funding.href}
                className="bg-bid text-ink hover:bg-bid/90 mt-2.5 inline-flex w-full items-center justify-center rounded-sm px-3 py-2 text-[0.82rem] font-medium transition-colors"
              >
                {funding.action}
              </a>
            )}
          </div>
        )}

        {validation && (
          <p className="text-danger mb-2.5 text-[0.78rem] leading-5" role="status">
            {validation}
          </p>
        )}

        <Button
          full
          size="lg"
          tone={side === "buy" ? "buy" : "sell"}
          busy={busy}
          disabled={disabled}
          disabledReason={validation ?? (complete ? undefined : "Enter a limit price and quantity.")}
          onClick={onSubmit}
        >
          {side === "buy" ? "Buy" : "Sell"} {label}
        </Button>

        {/* Where the order ended up, not merely that it confirmed. Rendered
            above the step list so it is the first thing read once the flow
            finishes. */}
        {outcome && (
          <div
            data-fill-outcome
            role="status"
            aria-live="polite"
            className={`rise-in mt-3 rounded-sm border px-3 py-2.5 ${
              outcome.kind === "filled"
                ? "border-p/35 bg-p/8"
                : outcome.kind === "partial"
                  ? "border-n/35 bg-n/8"
                  : "border-line bg-panel-2"
            }`}
          >
            <p
              className={`text-[0.8rem] leading-5 font-medium ${
                outcome.kind === "filled"
                  ? "text-p"
                  : outcome.kind === "partial"
                    ? "text-n"
                    : "text-muted"
              }`}
            >
              {outcome.message}
            </p>
            <p className="text-muted mt-1 text-[0.75rem] leading-5">{outcome.destination}</p>
          </div>
        )}

        {complete && (
          <p className="text-dim mt-2.5 text-[0.75rem] leading-5">
            {side === "buy" ? "Buy up to" : "Sell up to"} {shown(sizeNumber)} {baseSymbol} at{" "}
            {side === "buy" ? "no more than" : "no less than"} {shown(priceNumber)} {quoteSymbol} each.
            Partial fills allowed.
            {/* Said before the first prompt, not discovered at the second one.
                An unannounced extra approval reads as a bug, and a MagicBlock
                prompt where Solana was expected reads as the wrong network. */}
            {approvals && <span className="text-muted block pt-1">{approvals}</span>}
          </p>
        )}
        {status}
      </div>
    </section>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="flex items-center gap-1">
        {label}
        {hint && <InfoDot hint={hint} />}
      </dt>
      <dd className="text-text font-mono tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Desktop keeps the ticket beside the book. On a phone the full book remains
 * readable and one persistent action opens the same ticket as a bottom sheet.
 */
export function ResponsiveMarketTicket({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The portal target only exists in the browser; the static export prerenders
  // without it and attaches on hydration.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);

  /**
   * Dialog behaviour, done properly.
   *
   * The sheet was a `role="dialog"` that did none of what that promises: the
   * page behind it kept scrolling and kept taking focus, so a keyboard or
   * screen-reader user could tab straight out of the order form into the book
   * underneath without the sheet ever closing, and had no way to know they had
   * left. Closing it dropped focus at the top of the document rather than back
   * on the control that opened it.
   */
  useEffect(() => {
    if (!open) return;

    // Read through to the ref rather than capturing it. The sheet is portalled,
    // and if `sheet.current` is not attached yet when this effect runs, a
    // captured `null` stays null for every retry below -- which is exactly how
    // this failed intermittently rather than never.
    const node = () => sheet.current;
    const opener = trigger.current;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Everything outside the sheet is inert while it is up, which removes it
    // from the tab order and from the accessibility tree in one step.
    //
    // This is why the sheet is portalled directly under <body>: as a descendant
    // of the page it could not be separated from it, so marking the page inert
    // also silenced the sheet and the browser refused to focus into it.
    const siblings: { element: Element; had: boolean }[] = [];
    const isolate = () => {
      const current = node();
      if (!current || siblings.length) return;
      for (const child of Array.from(document.body.children)) {
        if (child.contains(current)) continue;
        siblings.push({ element: child, had: child.hasAttribute("inert") });
        child.setAttribute("inert", "");
      }
    };

    const focusable = () =>
      Array.from(
        node()?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    /**
     * Land on the first thing still to be filled in, not on the Close button.
     *
     * Attempted across a few frames rather than once: the book polls every
     * 1.5s, and a refresh landing between the sheet opening and this running
     * re-renders the subtree and drops the focus we just set. Skipped once
     * focus is already inside, so it never fights the user for the field they
     * moved to themselves.
     */
    const ensureFocus = () => {
      const current = node();
      if (!current || current.contains(document.activeElement)) return;
      const fields = focusable();
      const firstEmpty = fields.find(
        (el) => el instanceof HTMLInputElement && !el.value,
      );
      (firstEmpty ?? fields[0])?.focus();
    };

    const settle = () => {
      isolate();
      ensureFocus();
    };

    settle();
    const frames: number[] = [];
    const chase = (remaining: number) => {
      if (remaining <= 0) return;
      frames.push(
        requestAnimationFrame(() => {
          settle();
          chase(remaining - 1);
        }),
      );
    };
    chase(3);

    /**
     * Keep focus inside for as long as the sheet is up.
     *
     * `inert` on the rest of the page stops focus *moving* out, but not falling
     * out: the book refreshes every 1.5s, and when that re-render replaces the
     * element that had focus the browser drops focus to <body>, which is inside
     * nothing. Recovering it here is what a modal is supposed to do, and it is
     * why chasing animation frames alone could not make this reliable.
     */
    const onFocusOut = () => {
      // Deferred: during the change `document.activeElement` is still <body>
      // even when focus is about to land somewhere legitimate inside.
      window.setTimeout(() => {
        const current = node();
        if (!current) return;
        const active = document.activeElement;
        if (active && active !== document.body && current.contains(active)) return;
        ensureFocus();
      }, 0);
    };
    document.addEventListener("focusout", onFocusOut);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !node()?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      for (const frame of frames) cancelAnimationFrame(frame);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      for (const { element, had } of siblings) {
        if (!had) element.removeAttribute("inert");
      }
      // Back where they were, so closing the sheet does not lose their place.
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <aside data-market-ticket className="hidden space-y-3 lg:sticky lg:top-24 lg:block">
        {children}
      </aside>

      <div className="h-16 lg:hidden" aria-hidden="true" />
      {/* Clears the home indicator on a phone, which otherwise sits on top of
          the only action this bar exists for. */}
      <div className="border-line bg-bg/95 fixed inset-x-0 bottom-0 z-[60] border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <Button
          ref={trigger}
          data-mobile-trade-button
          full
          size="lg"
          tone="primary"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          Trade {label}
        </Button>
      </div>

      {/* Portalled directly under <body>, not rendered in place. As a
          descendant of the page it could not be separated from it: every body
          child either contained the sheet or was the whole page, so marking the
          page inert also silenced the sheet and the browser refused to focus
          into it. `overflow-hidden` keeps the slide-up inside the viewport. */}
      {open && host && createPortal(
        <div className="fixed inset-0 z-[80] overflow-hidden lg:hidden">
          <button
            type="button"
            aria-label="Close order ticket"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <section
            ref={sheet}
            data-market-ticket
            role="dialog"
            aria-modal="true"
            aria-label={`${label} order ticket`}
            className="bg-bg border-line sheet-in absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-xl border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="bg-line h-1 w-10 rounded-full" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="border-line text-muted hover:text-text rounded-sm border px-3 py-1.5 text-xs transition-colors"
              >
                Close
              </button>
            </div>
            {children}
          </section>
        </div>,
        host,
      )}
    </>
  );
}
