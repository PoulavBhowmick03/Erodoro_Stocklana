"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSeries } from "@/lib/use-series";
import { useFavourites } from "@/lib/use-favourites";
import { formatDate, priceToUsd, timeUntil } from "@/lib/format";
import {
  annualizedPremium,
  marketAsset,
  marketStatus,
} from "@/lib/market-presentation";
import type { SeriesView } from "@/lib/series-types";
import type { MarketRowMetrics } from "@/lib/use-market-row";
import type { Role } from "./role-toggle";
import { MarketMetrics } from "./market-metrics";
import { Button, EmptyState, Segmented } from "./ui";

const selectClass =
  "border-line bg-panel focus:border-accent w-full rounded-sm border px-3 py-1.5 text-[0.85rem] outline-none";
const dollars = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toFixed(2)}`;

/** Base's discovery layout using canonical Solana series and Manifest quotes. */
export function MarketsTable({
  onOpen,
  intent,
}: {
  onOpen: (address: string) => void;
  intent: Role;
}) {
  const { state, reload } = useSeries();
  const params = useSearchParams();
  const fav = useFavourites();
  const [tab, setTab] = useState("active");
  const [query, setQuery] = useState("");
  const [stock, setStock] = useState(params.get("stock") ?? "all");
  const [expiry, setExpiry] = useState("all");
  const [distance, setDistance] = useState("all");
  const [bid, setBid] = useState("all");
  const [sort, setSort] = useState("opportunity");
  const [now, setNow] = useState(0);
  const [metrics, setMetrics] = useState<Record<string, MarketRowMetrics>>({});
  const receive = useCallback(
    (id: string, next: MarketRowMetrics) =>
      setMetrics((current) => ({ ...current, [id]: next })),
    [],
  );
  useEffect(() => {
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 15000);
    return () => clearInterval(timer);
  }, []);
  const all = state.kind === "ready" ? state.series : [];
  const active = (s: SeriesView) =>
    ["Open", "Paused"].includes(marketStatus(s, now));
  const stocks = [
    ...new Map(
      all.map((s) => {
        const a = marketAsset(s);
        return [a.mint, a] as const;
      }),
    ).values(),
  ];
  const rows = all
    .filter((s) => {
      const id = s.address.toBase58(),
        a = marketAsset(s),
        m = metrics[id];
      if (
        (tab === "active" && !active(s)) ||
        (tab === "matured" && active(s)) ||
        (tab === "starred" && !fav.has(id))
      )
        return false;
      if (stock !== "all" && a.mint !== stock) return false;
      const remaining = s.config.maturityTs.toNumber() - now;
      if (
        expiry !== "all" &&
        (remaining <= 0 || remaining > Number(expiry) * 86400)
      )
        return false;
      if (bid === "live" && (m?.bookState !== "ready" || m.bestBid === null))
        return false;
      if (bid === "none" && (m?.bookState !== "ready" || m.bestBid !== null))
        return false;
      if (distance !== "all") {
        const d = m?.distancePct;
        if (
          d == null ||
          (distance === "0-10" && (d < 0 || d > 10)) ||
          (distance === "10-20" && (d < 10 || d > 20)) ||
          (distance === "20+" && d < 20)
        )
          return false;
      }
      return `${a.symbol} ${a.name} ${a.mint} ${id} ${priceToUsd(s.config.strike, s.config.priceDecimals)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    })
    .sort((a, b) => {
      if (sort === "expiry")
        return a.config.maturityTs.cmp(b.config.maturityTs);
      if (sort === "strike")
        return (
          Number(a.config.strike.toString()) / 10 ** a.config.priceDecimals -
          Number(b.config.strike.toString()) / 10 ** b.config.priceDecimals
        );
      if (sort === "premium")
        return (
          (metrics[b.address.toBase58()]?.bestBid ?? -1) -
          (metrics[a.address.toBase58()]?.bestBid ?? -1)
        );
      return (
        (annualizedPremium(b, metrics[b.address.toBase58()], now) ?? -1) -
        (annualizedPremium(a, metrics[a.address.toBase58()], now) ?? -1)
      );
    });
  const counts = {
    active: all.filter(active).length,
    matured: all.filter((s) => !active(s)).length,
    starred: all.filter((s) => fav.has(s.address.toBase58())).length,
  };
  return (
    <div>
      {all.map((view) => (
        <MarketMetrics
          key={view.address.toBase58()}
          view={view}
          onMetrics={receive}
        />
      ))}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Market lifecycle"
          value={tab}
          onChange={setTab}
          options={Object.entries(counts).map(([value, count]) => ({
            value,
            label: (
              <span className="capitalize">
                {value}
                <span className="ml-1.5 font-mono text-[0.75rem] opacity-60">
                  {count}
                </span>
              </span>
            ),
          }))}
        />
        <div className="border-line bg-panel focus-within:border-accent flex min-w-0 basis-full flex-1 items-center gap-2 rounded-sm border px-3 sm:basis-0">
          <span aria-hidden className="text-dim">
            ⌕
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search strike, underlying, or token address"
            aria-label="Search markets"
            className="placeholder:text-dim/70 min-w-0 w-full bg-transparent py-1.5 text-[0.85rem] outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="border-line-soft mb-5 grid items-end gap-3 border-b pb-4 sm:flex sm:flex-wrap">
        <label className="w-full sm:w-auto sm:min-w-[11rem]">
          <FilterLabel>Stock</FilterLabel>
          <select
            aria-label="Stock"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            className={selectClass}
          >
            <option value="all">All stocks</option>
            {stocks.map((a) => (
              <option key={a.mint} value={a.mint}>
                {a.symbol} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="min-w-0 overflow-x-auto">
          <FilterLabel>Expires within</FilterLabel>
          <Segmented
            label="Expiry window"
            size="sm"
            value={expiry}
            onChange={setExpiry}
            options={["all", "7", "14", "30", "60"].map((value) => ({
              value,
              label: value === "all" ? "All" : `${value}D`,
            }))}
          />
        </div>
        <div className="min-w-0 overflow-x-auto">
          <FilterLabel>Sell-price distance</FilterLabel>
          <Segmented
            label="Sell-price distance"
            size="sm"
            value={distance}
            onChange={setDistance}
            options={[
              { value: "all", label: "All" },
              { value: "0-10", label: "0–10%" },
              { value: "10-20", label: "10–20%" },
              { value: "20+", label: "20%+" },
            ]}
          />
        </div>
        <label className="w-full sm:w-auto sm:min-w-[12rem]">
          <FilterLabel>Rank by</FilterLabel>
          <select
            aria-label="Rank by"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className={selectClass}
          >
            <option value="opportunity">Highest annualized premium</option>
            <option value="premium">Highest cash premium</option>
            <option value="expiry">Shortest expiry</option>
            <option value="strike">Lowest sell price</option>
          </select>
        </label>
        <div className="min-w-0 overflow-x-auto">
          <FilterLabel>Bid status</FilterLabel>
          <Segmented
            label="Bid status"
            size="sm"
            value={bid}
            onChange={setBid}
            options={[
              { value: "all", label: "All" },
              { value: "live", label: "Live bid" },
              { value: "none", label: "No bid" },
            ]}
          />
        </div>
      </div>
      {state.kind === "loading" || !now ? (
        <div role="status" className="text-muted py-8 text-sm">
          Loading markets…
        </div>
      ) : state.kind === "error" || state.kind === "undeployed" ? (
        <EmptyState
          title={
            state.kind === "error"
              ? "Could not load markets"
              : "Not deployed on this network"
          }
          body={
            state.kind === "error"
              ? state.message
              : "These contracts are not available on the selected Solana network."
          }
          action={<Button onClick={reload}>Try again</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={all.length ? "No matching markets" : "No markets listed yet"}
          body="Try another stock, expiry or bid filter, or check back when a new series is listed."
        />
      ) : (
        <>
          <div className="grid gap-2 md:hidden">
            {rows.map((view) => (
              <MarketDisplay
                key={view.address.toBase58()}
                view={view}
                metrics={metrics[view.address.toBase58()]}
                now={now}
                card
                intent={intent}
                starred={fav.has(view.address.toBase58())}
                onStar={() => fav.toggle(view.address.toBase58())}
                onOpen={() => onOpen(view.address.toBase58())}
              />
            ))}
          </div>
          <div className="border-line bg-panel hidden overflow-x-auto border-y md:block">
            <table className="w-full min-w-[74rem] border-collapse text-left">
              <thead>
                <tr className="border-line-soft text-dim border-b text-[0.8125rem] tracking-wide uppercase">
                  {[
                    "☆",
                    "Market",
                    "Reference",
                    "Strike",
                    "Distance",
                    "Expiry",
                    "Best bid",
                    "Annualized*",
                    "Bid size",
                    "Status",
                    "",
                  ].map((name, i) => (
                    <th
                      key={i}
                      className={`px-3 py-2.5 font-normal ${i > 1 && i < 9 ? "text-right" : ""}`}
                    >
                      {name || <span className="sr-only">Open market</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((view) => (
                  <MarketDisplay
                    key={view.address.toBase58()}
                    view={view}
                    metrics={metrics[view.address.toBase58()]}
                    now={now}
                    intent={intent}
                    starred={fav.has(view.address.toBase58())}
                    onStar={() => fav.toggle(view.address.toBase58())}
                    onOpen={() => onOpen(view.address.toBase58())}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-dim mt-3 text-[0.75rem] leading-5">
            * Indicative simple annualized premium uses the current book bid,
            reference price and remaining term. It assumes an unchanged token
            multiplier and does not compound or include fees, dividends or
            rewards. Prices and liquidity can change before execution.
          </p>
        </>
      )}
      <p className="text-dim mt-3 text-xs">
        24h volume is unavailable without a trade-history indexer.
      </p>
    </div>
  );
}

function FilterLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-dim mb-1.5 block text-[0.72rem] tracking-[0.08em] uppercase">
      {children}
    </span>
  );
}

function MarketDisplay({
  view,
  metrics: m,
  now,
  starred,
  onStar,
  onOpen,
  card = false,
  intent,
}: {
  view: SeriesView;
  metrics?: MarketRowMetrics;
  now: number;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
  card?: boolean;
  intent: Role;
}) {
  const a = marketAsset(view),
    status = marketStatus(view, now);
  const ended = status === "Redeemable" || status === "Awaiting settlement";
  const rate = annualizedPremium(view, m, now);
  const expiry = ended
    ? "Expired"
    : timeUntil(view.config.maturityTs.toNumber());
  const premium = ended
    ? "—"
    : !m || m.bookState === "loading"
      ? "Checking bids…"
      : m.bookState === "unavailable"
        ? "Unavailable"
        : m.bestBid === null
          ? "No live bid"
          : `${m.bestBid.toFixed(2)} USDC`;
  const star = (
    <button
      type="button"
      aria-label={starred ? "Unstar this market" : "Star this market"}
      data-tour-no-advance
      onClick={(e) => {
        e.stopPropagation();
        onStar();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={starred ? "text-accent" : "text-dim"}
    >
      {starred ? "★" : "☆"}
    </button>
  );
  const pill = (
    <span
      className={`inline-flex rounded-sm border px-2 py-0.5 text-xs ${status === "Open" ? "border-p/25 bg-p/8 text-p" : "border-line text-muted"}`}
    >
      {status}
    </span>
  );
  if (card)
    return (
      <article className="border-line bg-panel rounded-md border p-3">
        <div className="flex justify-between gap-2">
          <button
            type="button"
            data-tour="series-card"
            onClick={onOpen}
            className="min-w-0 text-left"
          >
            <span className="block font-medium">{a.symbol} / USDC</span>
            <span className="text-dim text-xs">{a.name}</span>
          </button>
          <div className="flex items-center gap-2">
            {pill}
            {star}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-[0.8125rem]">
          {[
            [
              "Sell price",
              priceToUsd(view.config.strike, view.config.priceDecimals),
            ],
            ["Reference", dollars(m?.spot)],
            [
              "Distance",
              m?.distancePct == null ? "—" : `${m.distancePct.toFixed(1)}%`,
            ],
            ["Expiry", expiry],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-dim text-[0.7rem] uppercase">{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="border-line-soft mt-3 flex justify-between gap-3 border-t pt-3">
          <div>
            <p className="text-dim text-xs">Best bid</p>
            <p className="font-mono">{premium}</p>
          </div>
          <div className="text-right">
            <p className="text-dim text-xs">Annualized*</p>
            <p className="font-mono">
              {rate === null ? "—" : `${rate.toFixed(1)}%`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="text-accent-ink mt-3 text-sm underline"
        >
          {ended
            ? "View settlement"
            : intent === "seller"
              ? "Sell upside"
              : "Buy upside"}{" "}
          →
        </button>
      </article>
    );
  return (
    <tr
      data-tour="series-card"
      tabIndex={0}
      role="link"
      aria-label={`Open ${a.symbol} market`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="border-line-soft hover:bg-panel-2/60 focus-visible:outline-accent cursor-pointer border-b transition-colors focus-visible:outline-2"
    >
      <td className="px-2 py-3.5">{star}</td>
      <td className="px-3 py-3.5">
        <div className="font-medium">{a.symbol} / USDC</div>
        <div className="text-dim mt-0.5 text-xs">{a.name}</div>
      </td>
      <td className="px-3 py-3.5 text-right font-mono">{dollars(m?.spot)}</td>
      <td className="px-3 py-3.5 text-right font-mono">
        {priceToUsd(view.config.strike, view.config.priceDecimals)}
      </td>
      <td className="text-p px-3 py-3.5 text-right font-mono">
        {m?.distancePct == null
          ? "—"
          : `${m.distancePct >= 0 ? "+" : ""}${m.distancePct.toFixed(1)}%`}
      </td>
      <td
        title={formatDate(view.config.maturityTs.toNumber())}
        className="px-3 py-3.5 text-right font-mono"
      >
        {expiry}
      </td>
      <td className="px-3 py-3.5 text-right font-mono">{premium}</td>
      <td className="px-3 py-3.5 text-right font-mono">
        {rate === null ? "—" : `${rate.toFixed(1)}%`}
      </td>
      <td className="px-3 py-3.5 text-right font-mono">
        {ended || m?.bestBidSize == null
          ? "—"
          : m.bestBidSize.toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })}
      </td>
      <td className="px-3 py-3.5">{pill}</td>
      <td aria-hidden className="px-3 py-3.5">
        →
      </td>
    </tr>
  );
}
