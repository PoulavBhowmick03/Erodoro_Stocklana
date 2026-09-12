"use client";

import Link from "next/link";
import { IS_DEVNET } from "@/lib/network-config";
import { usePositions, type Position } from "@/lib/use-positions";
import { formatDate, fromRaw, priceToUsd, shortKey, statusOf, timeUntil } from "@/lib/format";
import { ACTIVE_ISSUER } from "@/lib/issuers";
import { EmptyState } from "./ui";

/**
 * What to call the thing a position is written on.
 *
 * The column was rendering `shortKey(collateralMint)` — a truncated base58
 * address — under the heading "Underlying". That is the one column a holder
 * scans to find a position, and an address is not something anyone recognises
 * theirs by. The issuer registry knows the symbol; fall back to the address
 * only when it genuinely does not.
 */
function underlyingLabel(mint: { toBase58(): string }) {
  const asset = ACTIVE_ISSUER.asset(mint.toBase58());
  if (asset) return { symbol: asset.symbol, detail: asset.name };
  return { symbol: IS_DEVNET ? "DEMO" : "Unknown", detail: shortKey(mint, 4) };
}

/**
 * What the connected key actually holds, across every canonical series.
 *
 * Without this a holder has no way to answer "what do I own" short of reading
 * their token accounts and matching mints by hand. Pendle puts this behind a
 * Portfolio tab; here it is a tab beside the contracts, because there are two
 * things a returning user wants and this is one of them.
 *
 * The claimable figure is an *entitlement*, computed the way the program pays
 * out: pro-rata against the pool the settlement recorded. It is deliberately
 * not called a balance — if the vault came up short, every redeemer takes the
 * same haircut, and the row says so rather than quoting a number that will not
 * arrive.
 */
export function PositionsPanel({ onOpen }: { onOpen: (address: string) => void }) {
  const { positions, loading } = usePositions();

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="border-line bg-panel h-16 animate-pulse rounded-lg border" />
        ))}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <EmptyState
        title="No positions yet"
        body="Lock tokenized equity to create P and N, or buy a claim from a market."
        action={
          <>
            <Link
              href="/app"
              className="bg-text text-bg hover:bg-accent rounded-sm px-4 py-2 text-sm transition-colors"
            >
              Explore markets
            </Link>
            {IS_DEVNET && (
              <Link
                href="/mint"
                className="border-line hover:border-text rounded-sm border px-4 py-2 text-sm transition-colors"
              >
                Create demo assets
              </Link>
            )}
          </>
        }
      />
    );
  }

  const settled = positions.filter((p) => p.claimable !== null);
  const expiring = positions.filter((p) => {
    const seconds = p.view.config.maturityTs.toNumber() - Math.floor(Date.now() / 1000);
    return seconds > 0 && seconds <= 7 * 86_400;
  });
  const totalP = positions.reduce(
    (sum, position) => sum + Number(fromRaw(position.p, position.decimals, position.decimals)),
    0,
  );
  const totalN = positions.reduce(
    (sum, position) => sum + Number(fromRaw(position.n, position.decimals, position.decimals)),
    0,
  );

  return (
    <div className="space-y-5">
      <div className="border-line grid border-y sm:grid-cols-4 sm:divide-x sm:divide-[var(--color-line)]">
        {[
          ["Positions", positions.length.toLocaleString()],
          ["P balance", totalP.toLocaleString(undefined, { maximumFractionDigits: 4 })],
          ["N balance", totalN.toLocaleString(undefined, { maximumFractionDigits: 4 })],
          ["Redeemable", settled.length.toLocaleString()],
        ].map(([label, value], index) => (
          <div key={label} className="border-line border-b py-4 last:border-b-0 sm:border-b-0 sm:px-5 sm:first:pl-0">
            <div className="text-dim font-mono text-[0.8125rem] tracking-[0.12em] uppercase">{label}</div>
            <div className={`mt-1 font-mono text-xl tabular-nums ${index === 1 ? "text-p" : index === 2 ? "text-n" : "text-text"}`}>{value}</div>
          </div>
        ))}
      </div>

      {expiring.length > 0 && (
        <div className="border-n/30 bg-n/5 rounded-sm border px-4 py-3">
          <p className="text-n text-[0.85rem]">
            {expiring.length} {expiring.length === 1 ? "position expires" : "positions expire"} within seven days.
          </p>
        </div>
      )}

      {settled.length > 0 && (
        <div className="border-p/30 bg-p/5 rounded-sm border px-4 py-2.5">
          <p className="text-muted text-[0.85rem]">
            {settled.length === 1
              ? "One position has settled and is waiting to be redeemed."
              : `${settled.length} positions have settled and are waiting to be redeemed.`}
          </p>
        </div>
      )}

      <div className="grid gap-2 md:hidden">
        {positions.map((pos) => (
          <PositionCard
            key={pos.view.address.toBase58()}
            pos={pos}
            onOpen={() => onOpen(pos.view.address.toBase58())}
          />
        ))}
      </div>

      <div className="border-line bg-panel shadow-panel hidden overflow-x-auto rounded-md border md:block">
        <table className="w-full min-w-[40rem] border-collapse text-left">
          <thead>
            <tr className="border-line-soft text-dim border-b text-[0.8125rem] tracking-wide uppercase">
              <th className="px-3 py-2.5 font-normal">Underlying</th>
              <th className="px-3 py-2.5 font-normal">Strike</th>
              <th className="px-3 py-2.5 font-normal">P balance</th>
              <th className="px-3 py-2.5 font-normal">N balance</th>
              <th className="px-3 py-2.5 font-normal">Expiry</th>
              <th className="px-3 py-2.5 font-normal">Status</th>
              <th className="px-3 py-2.5 font-normal">Action</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => (
              <Row
                key={pos.view.address.toBase58()}
                pos={pos}
                onOpen={() => onOpen(pos.view.address.toBase58())}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * What a position needs to say when a seven-column table will not fit.
 *
 * The table was the only rendering, inside a 40rem horizontal scroller, so on a
 * phone the action button for every position sat off the right edge of the
 * screen — reachable only by swiping a region that did not look scrollable.
 */
function PositionCard({ pos, onOpen }: { pos: Position; onOpen: () => void }) {
  const { config } = pos.view;
  const status = statusOf(config.status);
  const maturity = config.maturityTs.toNumber();
  const underlying = underlyingLabel(config.collateralMint);
  const zero = BigInt(0);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="border-line bg-panel hover:border-text w-full rounded-md border p-3 text-left transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{underlying.symbol}</div>
          <div className="text-dim mt-0.5 font-mono text-[0.75rem]">
            {priceToUsd(config.strike, config.priceDecimals)} strike
          </div>
        </div>
        <span className="text-[0.75rem]">
          {pos.shortfall ? (
            <span className="text-danger">Shortfall haircut</span>
          ) : pos.claimable !== null ? (
            <span className="text-p">Redeemable</span>
          ) : maturity <= Math.floor(Date.now() / 1000) ? (
            <span className="text-n">Settlement pending</span>
          ) : (
            <span className="text-muted">Open</span>
          )}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-[0.8125rem]">
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">P</dt>
          <dd className={`font-mono ${pos.p > zero ? "text-p" : "text-dim"}`}>
            {pos.p > zero ? fromRaw(pos.p, pos.decimals) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">N</dt>
          <dd className={`font-mono ${pos.n > zero ? "text-n" : "text-dim"}`}>
            {pos.n > zero ? fromRaw(pos.n, pos.decimals) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Expiry</dt>
          <dd>{status === "Settled" ? "settled" : timeUntil(maturity)}</dd>
        </div>
      </dl>
    </button>
  );
}

function Row({ pos, onOpen }: { pos: Position; onOpen: () => void }) {
  const { config } = pos.view;
  const status = statusOf(config.status);
  const maturity = config.maturityTs.toNumber();
  const underlying = underlyingLabel(config.collateralMint);
  const zero = BigInt(0);
  const action = pos.claimable !== null
    ? `Redeem ${pos.p > zero && pos.n > zero ? "P or N" : pos.p > zero ? "P" : "N"}`
    : maturity <= Math.floor(Date.now() / 1000)
      ? "Settle"
      : pos.p > zero && pos.n > zero
        ? "Merge P + N"
        : "View market";

  return (
    <tr
      tabIndex={0}
      role="link"
      aria-label={`Open the ${underlying.symbol} position struck at ${priceToUsd(config.strike, config.priceDecimals)}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="border-line-soft hover:bg-panel-2/70 cursor-pointer border-b transition-colors last:border-b-0"
    >
      <td className="px-3 py-3">
        <div className="font-medium">{underlying.symbol}</div>
        <div className="text-dim mt-0.5 font-mono text-[0.75rem]">{underlying.detail}</div>
      </td>
      <td className="px-3 py-3 font-mono">
        {priceToUsd(config.strike, config.priceDecimals)}
      </td>
      <td className="px-3 py-3 font-mono">
        {pos.p > zero ? (
          <span className="text-p">{fromRaw(pos.p, pos.decimals)}</span>
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      <td className="px-3 py-3 font-mono">
        {pos.n > zero ? (
          <span className="text-n">{fromRaw(pos.n, pos.decimals)}</span>
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="text-muted text-[0.85rem]">{formatDate(maturity)}</div>
        <div className="text-dim font-mono text-[0.75rem]">
          {status === "Settled" ? "settled" : timeUntil(maturity)}
        </div>
      </td>
      <td className="px-3 py-3 text-[0.82rem]">
        {pos.shortfall ? (
          <span className="text-danger">Shortfall haircut</span>
        ) : pos.claimable !== null ? (
          <span className="text-p">Redeemable · {fromRaw(pos.claimable, pos.decimals)}</span>
        ) : maturity <= Math.floor(Date.now() / 1000) ? (
          <span className="text-n">Expired · settlement pending</span>
        ) : (
          <span className="text-muted">Open</span>
        )}
      </td>
      <td className="px-3 py-3">
        <button onClick={onOpen} className="text-accent-ink text-[0.82rem] hover:underline">{action}</button>
      </td>
    </tr>
  );
}
