"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getTokenMetadata } from "@solana/spl-token";
import { useSeries } from "@/lib/use-series";
import type { SeriesView } from "@/lib/series-types";
import { useFavourites } from "@/lib/use-favourites";
import { formatDate, priceToUsd, shortKey, statusOf, timeUntil } from "@/lib/format";
import { ACTIVE_ISSUER } from "@/lib/issuers";
import { IS_DEVNET } from "@/lib/network-config";
import { useMarketRowMetrics } from "@/lib/use-market-row";
import { DEVNET_MARKET_PROFILE, marketProfileForCollateral } from "@/lib/market-profile";
import { useMagicBlockPrice } from "@/lib/use-magicblock-price";
import type { Role } from "./role-toggle";
import { Button, EmptyState, Segmented } from "./ui";

/** Which slice of the registry is on screen. */
type Tab = "active" | "matured" | "starred";

/** Sortable columns. */
type SortKey = "expiry" | "strike";
type Sort = { key: SortKey; dir: "asc" | "desc" };

/**
 * A series is "new" if it is among the last few the factory registered.
 * `SeriesRecord.index` is creation order, which is the only thing on chain
 * that can answer this.
 */
export function MarketsTable({ onOpen, intent }: { onOpen: (address: string) => void; intent: Role }) {
  const { connection } = useConnection();
  const { state, reload } = useSeries();
  const { has, toggle } = useFavourites();
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "expiry", dir: "asc" });
  const realtime = useMagicBlockPrice(IS_DEVNET ? DEVNET_MARKET_PROFILE.realtime : null);
  const realtimeSpot = realtime.state.kind === "ready" ? realtime.state.price : null;

  const all = state.kind === "ready" ? state.series : [];
  const [mintLabels, setMintLabels] = useState<Record<string, { name: string; symbol: string }>>({});

  useEffect(() => {
    let live = true;
    const mints = [...new Set(all.map((view) => view.config.collateralMint.toBase58()))]
      .filter((mint) => !mintLabels[mint]);
    if (!mints.length) return;
    void Promise.all(
      mints.map(async (mint) => {
        const issuerAsset = ACTIVE_ISSUER.asset(mint);
        if (issuerAsset) {
          return [mint, { name: issuerAsset.name, symbol: issuerAsset.symbol }] as const;
        }
        const address = all.find((view) => view.config.collateralMint.toBase58() === mint)!.config.collateralMint;
        const metadata = await getTokenMetadata(connection, address).catch(() => null);
        const profile = marketProfileForCollateral(mint);
        return [mint, {
          name: profile?.name || metadata?.name?.trim() || "Unknown collateral",
          symbol: profile?.symbol || metadata?.symbol?.trim() || "UNKNOWN",
        }] as const;
      }),
    ).then((entries) => {
      if (live) setMintLabels((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => { live = false; };
  }, [all, connection, mintLabels]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = all.filter((s) => {
      const status = statusOf(s.config.status);
      const expired = s.config.maturityTs.toNumber() <= Math.floor(Date.now() / 1000);
      if (tab === "active" && (status === "Settled" || expired)) return false;
      if (tab === "matured" && status !== "Settled" && !expired) return false;
      if (tab === "starred" && !has(s.address.toBase58())) return false;
      if (!q) return true;
      // Search the things a person would actually type: the strike, the series
      // address, or the collateral they are looking to lock up.
      return (
        priceToUsd(s.config.strike, s.config.priceDecimals).toLowerCase().includes(q) ||
        s.address.toBase58().toLowerCase().includes(q) ||
        s.config.collateralMint.toBase58().toLowerCase().includes(q) ||
        mintLabels[s.config.collateralMint.toBase58()]?.name.toLowerCase().includes(q) ||
        mintLabels[s.config.collateralMint.toBase58()]?.symbol.toLowerCase().includes(q)
      );
    });

    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "strike") {
        return a.config.strike.cmp(b.config.strike) * dir;
      }
      return (a.config.maturityTs.toNumber() - b.config.maturityTs.toNumber()) * dir;
    });
  }, [all, tab, query, sort, has, mintLabels]);

  if (state.kind === "loading") {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="border-line bg-panel h-14 animate-pulse rounded-lg border" />
        ))}
      </div>
    );
  }

  if (state.kind === "undeployed") {
    return (
      <Empty
        title="Not deployed on this network"
        body="The markets this page reads are not on this cluster. Switch networks, or deploy them."
        onRetry={reload}
      />
    );
  }

  if (state.kind === "error") {
    return (
      <Empty
        title="Could not reach the network"
        body={<span className="font-mono text-[0.85rem]">{state.message}</span>}
        onRetry={reload}
      />
    );
  }

  const counts = {
    active: all.filter((s) => statusOf(s.config.status) !== "Settled" && s.config.maturityTs.toNumber() > Math.floor(Date.now() / 1000)).length,
    matured: all.filter((s) => statusOf(s.config.status) === "Settled" || s.config.maturityTs.toNumber() <= Math.floor(Date.now() / 1000)).length,
    starred: all.filter((s) => has(s.address.toBase58())).length,
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Market lifecycle"
          value={tab}
          onChange={setTab}
          options={(["active", "matured", "starred"] as Tab[]).map((t) => ({
            value: t,
            label: (
              <span className="capitalize">
                {t}
                <span className="ml-1.5 font-mono text-[0.75rem] opacity-60">{counts[t]}</span>
              </span>
            ),
          }))}
        />

        <div className="border-line bg-panel focus-within:border-accent hover:border-muted flex min-w-[16rem] flex-1 items-center gap-2 rounded-sm border px-3 transition-colors">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search strike, underlying, or series address"
            aria-label="Search markets"
            className="placeholder:text-dim/70 w-full bg-transparent py-1.5 text-[0.85rem] outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="text-dim hover:text-text shrink-0 text-sm transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyRows tab={tab} query={query} total={all.length} onRetry={reload} />
      ) : (
        <>
        <div className="grid gap-2 md:hidden">
          {rows.map((s) => (
            <MarketCard
              key={s.address.toBase58()}
              view={s}
              label={mintLabels[s.config.collateralMint.toBase58()]}
              intent={intent}
              starred={has(s.address.toBase58())}
              onStar={() => toggle(s.address.toBase58())}
              onOpen={() => onOpen(s.address.toBase58())}
            />
          ))}
        </div>
        <div className="border-line bg-panel hidden overflow-x-auto border-y md:block">
          <table className="w-full min-w-[62rem] border-collapse text-left">
            <thead>
              <tr className="border-line-soft text-dim border-b text-[0.8125rem] tracking-wide uppercase">
                <th className="px-3 py-2.5 font-normal">Market</th>
                <th className="px-3 py-2.5 text-right font-normal">Spot</th>
                <Header
                  label="Strike"
                  active={sort.key === "strike"}
                  dir={sort.dir}
                  onClick={() => setSort(flip(sort, "strike"))}
                />
                <th className="px-3 py-2.5 text-right font-normal">Distance</th>
                <Header
                  label="Expiry"
                  active={sort.key === "expiry"}
                  dir={sort.dir}
                  onClick={() => setSort(flip(sort, "expiry"))}
                />
                <th className="px-3 py-2.5 text-right font-normal">Bid / Ask</th>
                <th className="px-3 py-2.5 text-right font-normal">Premium</th>
                <th className="px-3 py-2.5 font-normal">Status</th>
                <th className="px-3 py-2.5 font-normal">
                  <span className="sr-only">Open market</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Row
                  key={s.address.toBase58()}
                  view={s}
                  label={mintLabels[s.config.collateralMint.toBase58()]}
                  intent={intent}
                  realtimeSpot={realtimeSpot}
                  starred={has(s.address.toBase58())}
                  onStar={() => toggle(s.address.toBase58())}
                  onOpen={() => onOpen(s.address.toBase58())}
                />
              ))}
            </tbody>
          </table>
        </div>
        {/* Manifest stores the live book but no durable fill history, so there
            is no 24-hour volume to report. It used to be a column, which meant
            every row carried a permanent "—" and the table read as broken.
            Saying it once, here, is the same disclosure without the noise. */}
        <p className="text-dim mt-3 text-[0.75rem]">
          Bid and ask are live. 24-hour fill volume is not shown: it needs a
          trade-history indexer, which this deployment does not run yet.
        </p>
        </>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="text-dim size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.4 10.4 3.1 3.1" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The same row, for a viewport a nine-column table does not fit on.
 *
 * The table used to be the only rendering, inside a horizontal scroller with a
 * 62rem minimum. On a phone that meant the status of a market lived four
 * swipes to the right of its name, which is the same as not showing it.
 */
function MarketCard({
  view,
  label,
  intent,
  starred,
  onStar,
  onOpen,
}: {
  view: SeriesView;
  label?: { name: string; symbol: string };
  intent: Role;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
}) {
  const { config, address } = view;
  const status = statusOf(config.status);
  const maturity = config.maturityTs.toNumber();
  const expired = status !== "Settled" && maturity <= Math.floor(Date.now() / 1000);
  const displayStatus = status === "Settled" ? "Redeemable" : expired ? "Awaiting settlement" : status;
  const metrics = useMarketRowMetrics(view, intent);

  return (
    /*
      A card, not a button.
      
      It used to be a <button> with the star control nested inside it, which is
      invalid: a control inside a control has no defined activation behaviour,
      and a screen reader announces one thing while two are reachable. The card
      is now inert markup; the market name is the control, stretched across the
      card so clicking anywhere still opens it, and the star sits above that
      overlay as an ordinary sibling.
    */
    <div
      data-tour="series-card"
      className="border-line bg-panel hover:border-text relative rounded-md border p-3 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onOpen}
            className="text-left before:absolute before:inset-0 before:content-['']"
          >
            <span className="block font-medium">{label?.symbol || "DEMO"} / USDC</span>
            <span className="text-dim mt-0.5 block font-mono text-[0.75rem]">
              {shortKey(address, 4)}
            </span>
          </button>
        </div>
        <div className="relative z-10 flex items-center gap-2">
          <StatusPill status={displayStatus} />
          <button
            type="button"
            aria-label={starred ? "Unstar this market" : "Star this market"}
            aria-pressed={starred}
            onClick={onStar}
            className={`leading-none ${starred ? "text-accent-ink" : "text-dim hover:text-muted"}`}
          >
            {starred ? "★" : "☆"}
          </button>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-[0.8125rem]">
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Strike</dt>
          <dd className="font-mono">{priceToUsd(config.strike, config.priceDecimals)}</dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Spot</dt>
          <dd className="font-mono">
            {metrics.spot === null ? "—" : `$${metrics.spot.toFixed(2)}`}
          </dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Expiry</dt>
          <dd>{status === "Settled" ? "—" : expired ? "Expired" : timeUntil(maturity)}</dd>
        </div>
      </dl>
    </div>
  );
}

function flip(sort: Sort, key: SortKey): Sort {
  if (sort.key !== key) return { key, dir: "asc" };
  return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
}

function Header({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th className="px-3 py-2.5 font-normal">
      <button
        onClick={onClick}
        className={`hover:text-muted inline-flex items-center gap-1 uppercase transition-colors ${
          active ? "text-text" : ""
        }`}
      >
        {label}
        <span className={active ? "" : "opacity-0"}>{dir === "asc" ? "↑" : "↓"}</span>
      </button>
    </th>
  );
}

function Row({
  view,
  label,
  intent,
  realtimeSpot,
  starred,
  onStar,
  onOpen,
}: {
  view: SeriesView;
  label?: { name: string; symbol: string };
  intent: Role;
  realtimeSpot: number | null;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
}) {
  const { config, address } = view;
  const status = statusOf(config.status);
  const maturity = config.maturityTs.toNumber();
  const expired = status !== "Settled" && maturity <= Math.floor(Date.now() / 1000);
  const displayStatus = status === "Settled" ? "Redeemable" : expired ? "Awaiting settlement" : status;
  const metrics = useMarketRowMetrics(view, intent, realtimeSpot);
  const money = (value: number | null) => value === null
    ? "—"
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signed = (value: number | null) => value === null
    ? "—"
    : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

  return (
    <tr
      data-tour="series-card"
      tabIndex={0}
      role="link"
      aria-label={`Open the ${label?.symbol || "DEMO"} market struck at ${priceToUsd(config.strike, config.priceDecimals)}, expiring ${formatDate(maturity)}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="border-line-soft hover:bg-panel-2/70 group cursor-pointer border-b transition-colors last:border-b-0"
    >
      <td className="px-3 py-3">
        <div className="flex items-center gap-3">
          <button
            aria-label={starred ? "Unstar this market" : "Star this market"}
            onClick={(e) => {
              e.stopPropagation();
              onStar();
            }}
            className={`text-base leading-none transition-colors ${
              starred ? "text-accent-ink" : "text-dim hover:text-muted"
            }`}
          >
            {starred ? "★" : "☆"}
          </button>
          <div className="min-w-0">
            <div className="text-text font-medium">
              {label?.symbol || (IS_DEVNET ? DEVNET_MARKET_PROFILE.symbol : "UNKNOWN")} / USDC
            </div>
            {/* Two series can share a symbol, a strike and an expiry date, and
                four of them did. Without the address the rows were literally
                indistinguishable and picking one was a coin flip. */}
            <div className="text-dim mt-0.5 flex items-center gap-1.5 text-[0.8125rem]">
              <span>
                {label?.name || (IS_DEVNET ? DEVNET_MARKET_PROFILE.name : "Unknown collateral")}
              </span>
              <span aria-hidden>·</span>
              <span className="font-mono">{shortKey(address, 4)}</span>
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right font-mono tabular-nums">{money(metrics.spot)}</td>
      <td className="px-3 py-3 text-right font-mono tabular-nums">
        {priceToUsd(config.strike, config.priceDecimals)}
      </td>
      <td className="px-3 py-3 text-right font-mono tabular-nums">{signed(metrics.distancePct)}</td>
      <td className="px-3 py-3">
        <div className="text-muted text-[0.8125rem]">{formatDate(maturity)}</div>
        <div className="text-dim text-[0.8125rem]">{status === "Settled" ? "—" : expired ? "Expired" : timeUntil(maturity)}</div>
      </td>
      <td className="px-3 py-3 text-right font-mono tabular-nums">
        <span className="text-bid">{money(metrics.bestBid)}</span>
        <span className="text-dim"> / </span>
        <span className="text-ask">{money(metrics.bestAsk)}</span>
      </td>
      <td className="px-3 py-3 text-right font-mono tabular-nums">{signed(metrics.premiumPct)}</td>
      <td className="px-3 py-3">
        <StatusPill status={displayStatus} />
      </td>
      <td className="px-3 py-3 text-right">
        <span className="text-accent-ink text-[0.8125rem] opacity-0 transition-opacity group-hover:opacity-100">
          Trade →
        </span>
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "Open"
      ? "text-accent-ink border-accent/30 bg-accent/10"
      : status === "Settled"
        ? "text-dim border-line bg-panel-2"
        : "text-muted border-line bg-panel-2";
  return (
    <span
      className={`rounded-sm border px-2 py-0.5 font-mono text-[0.8125rem] tracking-wide uppercase ${tone}`}
    >
      {status}
    </span>
  );
}

/**
 * An empty *filter* is a different problem from an empty *registry*, and the
 * fix is different too -- one is "clear your search", the other is "nothing
 * has been created yet".
 */
function EmptyRows({
  tab,
  query,
  total,
  onRetry,
}: {
  tab: Tab;
  query: string;
  total: number;
  onRetry: () => void;
}) {
  if (total === 0) {
    return (
      <Empty
        title="No markets are listed yet"
        body={IS_DEVNET
          ? "Create demo assets and list the first devnet market."
          : "No issuer-approved Mainnet markets have been listed yet."}
        onRetry={onRetry}
      />
    );
  }
  const reason = query
    ? "Try another strike, underlying address or expiry."
    : tab === "starred"
      ? "You have not starred anything yet. Use the star on a row to keep it here."
      : tab === "matured"
        ? "Nothing has settled yet."
        : "Everything here has already settled. Try the matured tab.";
  return (
    <EmptyState
      title={query ? "No matching markets" : tab === "starred" ? "Nothing starred" : "Nothing here"}
      body={reason}
    />
  );
}

function Empty({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: React.ReactNode;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      title={title}
      body={body}
      action={<Button onClick={onRetry}>Try again</Button>}
    />
  );
}
