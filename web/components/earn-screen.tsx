"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSeries } from "@/lib/use-series";
import { useTokenBalances } from "@/lib/use-token-balances";
import { useSigner } from "@/lib/use-signer";
import { useOrderDraft } from "@/lib/use-order-draft";
import { fromRaw, formatDate, priceToUsd, toRaw } from "@/lib/format";
import { marketAsset, marketStatus } from "@/lib/market-presentation";
import { useRole } from "./role-toggle";
import { AmountInput, Button, Panel } from "./ui";

/** Base's three-step seller layout, handing a draft to the real Manifest ticket. */
export function EarnScreen() {
  const router = useRouter(),
    params = useSearchParams();
  const { state, reload } = useSeries();
  const balances = useTokenBalances();
  const signer = useSigner();
  const [, setRole] = useRole();
  const [token, setToken] = useState(params.get("stock") ?? "");
  const [selected, setSelected] = useState("");
  const [qty, setQty] = useState("");
  const [premium, setPremium] = useState("");
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 15000);
    return () => clearInterval(timer);
  }, []);
  const all = state.kind === "ready" ? state.series : [];
  const active = all.filter((s) => marketStatus(s, now) === "Open");
  const options = [
    ...new Map(
      active.map((s) => {
        const asset = marketAsset(s);
        return [asset.mint, asset] as const;
      }),
    ).values(),
  ];
  const pool = active.filter(
    (s) => s.config.collateralMint.toBase58() === token,
  );
  const match = pool.find((s) => s.address.toBase58() === selected) ?? null;
  const asset = options.find((a) => a.mint === token);
  const dp =
    match?.config.collateralDecimals ?? pool[0]?.config.collateralDecimals ?? 8;
  const rawBalance =
    balances.state.kind === "ready"
      ? balances.state.holdings
          .filter((h) => h.mint === token)
          .reduce((sum, h) => sum + h.raw, BigInt(0))
      : null;
  const decimal = (s: string, decimals: number) =>
    new RegExp(decimals === 0 ? "^\\d+$" : `^\\d+(?:\\.\\d{1,${decimals}})?$`).test(s);
  const validQty = decimal(qty, dp),
    validPremium = decimal(premium, 6);
  const rawQty = validQty ? BigInt(toRaw(qty, dp)) : BigInt(0);
  const rawPremium = validPremium ? BigInt(toRaw(premium, 6)) : BigInt(0);
  const total = (rawQty * rawPremium) / BigInt(10) ** BigInt(dp);
  const draft = useOrderDraft(match?.address.toBase58() ?? null, "N");
  const reason = !token
    ? "Choose a stock to begin."
    : !match
      ? "Choose an available strike and expiry."
      : rawQty <= BigInt(0)
        ? "Enter a quantity greater than zero."
        : rawPremium <= BigInt(0)
          ? "Enter a minimum premium with up to 6 decimal places."
          : signer && rawBalance === null
            ? "Your wallet balance is not available yet."
            : signer && rawBalance !== null && rawQty > rawBalance
              ? "Lower the quantity to your wallet balance."
              : null;
  function review() {
    if (reason || !match) return;
    setRole("seller");
    draft.save({ side: "sell", price: premium, size: qty });
    router.push(`/trade/markets?market=${match.address.toBase58()}&view=n`);
  }
  return (
    <>
      {state.kind === "error" && (
        <div role="alert" className="text-danger mb-5 text-sm">
          Could not load listed terms.{" "}
          <button type="button" onClick={reload} className="underline">
            Try again
          </button>
        </div>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="border-line bg-panel rounded-md border p-4 sm:p-6">
          <section>
            <Step n="1">Choose your stock</Step>
            <label className="mt-4 block">
              <span className="sr-only">Stock</span>
              <select
                aria-label="Stock"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setSelected("");
                  setQty("");
                }}
                className="border-line bg-bg text-text w-full rounded-md border px-4 py-4 text-sm"
              >
                <option value="">
                  {state.kind === "loading"
                    ? "Loading stocks…"
                    : "Select stock"}
                </option>
                {options.map((a) => (
                  <option key={a.mint} value={a.mint}>
                    {a.symbol} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            {state.kind === "ready" && !active.length && (
              <p role="status" className="text-muted mt-3 text-sm">
                No active strategies are listed on this network yet.
              </p>
            )}
            {state.kind === "undeployed" && (
              <p role="status" className="text-muted mt-3 text-sm">
                Markets are not deployed on this network.
              </p>
            )}
            <fieldset disabled={!token} className="mt-5 min-w-0">
              <AmountInput
                label="Quantity"
                value={qty}
                onChange={setQty}
                placeholder="0"
                suffix={asset?.symbol}
                note={
                  !signer
                    ? "Connect a wallet to read your balance"
                    : rawBalance === null
                      ? "Balance unavailable"
                      : `Balance ${fromRaw(rawBalance, dp, 4)}`
                }
                onMax={
                  rawBalance === null
                    ? undefined
                    : () => setQty(fromRaw(rawBalance, dp, dp))
                }
                invalid={Boolean(
                  qty &&
                  (!validQty || (rawBalance !== null && rawQty > rawBalance)),
                )}
              />
              <input
                type="range"
                aria-label="Stock quantity"
                min={0}
                max={
                  rawBalance === null ? 0 : Number(fromRaw(rawBalance, dp, dp))
                }
                step="any"
                value={
                  validQty && Number.isFinite(Number(qty)) ? Number(qty) : 0
                }
                disabled={!rawBalance}
                onChange={(e) =>
                  setQty(Number(e.target.value).toFixed(Math.min(dp, 4)))
                }
                className="mt-3 w-full disabled:opacity-40"
              />
            </fieldset>
          </section>
          <section className="border-line-soft mt-7 border-t pt-6">
            <Step n="2">Set your terms</Step>
            <fieldset disabled={!token} className="mt-4 min-w-0 space-y-5">
              <label className="block">
                <span className="text-dim mb-2 block text-xs">
                  Sell upside above · Expiry
                </span>
                <select
                  aria-label="Strike and expiry"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  className="border-line bg-bg w-full rounded-md border px-3 py-3 text-sm"
                >
                  <option value="">Choose listed terms</option>
                  {pool.map((s) => (
                    <option
                      key={s.address.toBase58()}
                      value={s.address.toBase58()}
                    >
                      {priceToUsd(s.config.strike, s.config.priceDecimals)} cap
                      · {formatDate(s.config.maturityTs.toNumber())}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-dim text-xs">
                You keep the value up to this cap. The buyer gets the gains
                above it. Only listed terms are available.
              </p>
              <AmountInput
                label="Minimum premium per token"
                value={premium}
                onChange={setPremium}
                suffix="USDC"
                placeholder="10.00"
                invalid={Boolean(premium && !validPremium)}
              />
              <p className="text-dim text-xs">
                This becomes your limit sell price. An order may fill partially
                or remain unfilled.
              </p>
            </fieldset>
          </section>
        </div>
        <aside className="border-line bg-panel rounded-md border p-4 sm:p-6">
          <Step n="3">Review your upside</Step>
          <p className="text-muted mt-4 text-sm leading-6">
            {match && rawQty > BigInt(0)
              ? `Sell the upside on ${qty} ${asset?.symbol} above ${priceToUsd(match.config.strike, match.config.priceDecimals)}.`
              : "Choose your stock and terms to preview your sale."}
          </p>
          <dl className="mt-5 space-y-3 text-sm">
            {[
              ["Stock", asset?.symbol ?? "—"],
              ["Quantity", validQty ? qty : "—"],
              [
                "Cap",
                match
                  ? priceToUsd(match.config.strike, match.config.priceDecimals)
                  : "—",
              ],
              [
                "Expiry",
                match ? formatDate(match.config.maturityTs.toNumber()) : "—",
              ],
              ["Execution", "Manifest limit order"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="border-line-soft mt-5 border-t pt-5">
            <p className="text-muted text-xs">
              Minimum gross premium if fully filled
            </p>
            <p
              className="mt-2 font-mono text-2xl tabular-nums"
              aria-live="polite"
            >
              {total > BigInt(0) ? fromRaw(total, 6, 2) : "—"}{" "}
              <span className="text-muted text-sm">USDC</span>
            </p>
            <p className="text-dim mt-2 text-xs">
              Before fees. Nothing is locked or submitted on this page.
            </p>
          </div>
          <div className="mt-6">
            <Button
              tone="primary"
              size="lg"
              full
              disabled={!!reason}
              disabledReason={reason ?? undefined}
              onClick={review}
            >
              Review sell order
            </Button>
            {reason && <p className="text-dim mt-2 text-xs">{reason}</p>}
          </div>
          <p className="text-dim mt-4 text-xs leading-5">
            You keep the capped claim and the stock’s downside risk. Review
            collateral locking, session funding and wallet approvals in the
            market ticket.
          </p>
        </aside>
      </div>
      {!signer && (
        <p className="text-muted mt-4 text-sm">
          Connect a wallet to see your balances — you can still browse strikes
          and expiries first.
        </p>
      )}
      <div className="mt-8">
        <Panel title="Auctions" subtitle="Not available on Solana">
          <p className="text-muted text-sm">
            This network supports limit orders. Timed auctions and automatic
            bidding are not available.
          </p>
        </Panel>
      </div>
    </>
  );
}

function Step({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-3 text-base font-medium">
      <span className="border-line text-muted flex size-7 items-center justify-center rounded-full border font-mono text-xs">
        {n}
      </span>
      {children}
    </h2>
  );
}
