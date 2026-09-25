"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ACTIVE_ISSUER } from "@/lib/issuers";
import { useTokenBalances } from "@/lib/use-token-balances";
import { fromRaw } from "@/lib/format";
import { Button } from "./ui";

/** Source swap layout. No Base router or token approvals are carried across. */
export function StockSwap() {
  const params = useSearchParams();
  const [side, setSide] = useState<"buy" | "sell">(
    params.get("side") === "sell" ? "sell" : "buy",
  );
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("");
  const [search, setSearch] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const dialog = useRef<HTMLDialogElement>(null);
  const { state } = useTokenBalances();
  const assets = ACTIVE_ISSUER.listedAssets();
  const filteredAssets = assets.filter((a) =>
    `${a.name} ${a.symbol} ${a.issuer} ${a.mint}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const asset = assets.find((a) => a.mint === selected);
  const stockBalance =
    state.kind === "ready"
      ? state.holdings
          .filter((h) => h.mint === selected)
          .reduce((sum, h) => sum + Number(fromRaw(h.raw, h.decimals, 4)), 0)
      : null;
  const picker = (
    <button
      type="button"
      aria-label="Select stock"
      aria-haspopup="dialog"
      onClick={() => dialog.current?.showModal()}
      className="bg-panel-2 flex max-w-full items-center gap-2 rounded-full px-3 py-2 font-medium"
    >
      <TokenMark symbol={asset?.symbol} />
      <span className="truncate">{asset?.symbol ?? "Select stock"}</span>
      <span aria-hidden>⌄</span>
    </button>
  );
  const usdc = (
    <div className="bg-panel-2 inline-flex items-center gap-2 rounded-full px-3 py-2 font-medium">
      <TokenMark symbol="USDC" />
      USDC
    </div>
  );
  return (
    <main className="mx-auto w-full max-w-[536px] flex-1 px-4 py-8 sm:py-12">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-display text-3xl tracking-tight">Swap</h1>
        <span className="text-muted text-xs">On Solana</span>
      </div>
      <section
        aria-label="Swap tokens"
        className="border-line bg-panel rounded-3xl border p-4 shadow-sm sm:p-6"
      >
        <div className="border-line bg-bg rounded-2xl border p-4">
          <p className="text-muted mb-4 text-xs">You pay</p>
          <div className="flex items-center justify-between gap-3">
            <input
              aria-label="Amount to swap"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="min-w-0 w-full bg-transparent font-mono text-3xl outline-none"
            />
            {side === "buy" ? usdc : picker}
          </div>
          <p className="text-muted mt-4 text-xs">
            {side === "sell" && asset
              ? `Stock balance: ${stockBalance === null ? "Unavailable" : stockBalance}`
              : "Quote unavailable"}
          </p>
        </div>
        <div className="relative z-10 -my-3 flex justify-center">
          <button
            type="button"
            aria-label="Reverse swap direction"
            onClick={() => {
              setSide(side === "buy" ? "sell" : "buy");
              setAmount("");
            }}
            className="border-line bg-panel rounded-xl border p-2"
          >
            ↓
          </button>
        </div>
        <div className="border-line bg-bg rounded-2xl border p-4">
          <p className="text-muted mb-4 text-xs">You receive</p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-dim font-mono text-3xl">—</span>
            {side === "buy" ? picker : usdc}
          </div>
          <p className="text-muted mt-4 text-xs">No executable quote</p>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted text-xs">Slippage tolerance</p>
          <div
            className="flex gap-1"
            role="group"
            aria-label="Slippage tolerance"
          >
            {["0.1", "0.5", "1"].map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={slippage === value}
                onClick={() => setSlippage(value)}
                className={`rounded-md border px-3 py-1.5 text-xs ${slippage === value ? "border-accent text-accent-ink" : "border-line text-muted"}`}
              >
                {value}%
              </button>
            ))}
          </div>
        </div>
        <div className="mt-5">
          <Button
            tone="primary"
            size="lg"
            full
            disabled
            disabledReason="Stock swaps are not available on Solana yet."
          >
            Swap unavailable
          </Button>
        </div>
        <p role="status" className="text-muted mt-3 text-sm leading-6">
          Stock swaps are not available on this network. You can trade listed
          upside claims from{" "}
          <Link href="/app" className="underline underline-offset-4">
            Markets
          </Link>
          .
        </p>
      </section>
      <p className="text-dim mt-5 text-xs leading-5">
        Tokenized stocks carry issuer, eligibility and market risks. No quote or
        token approval is requested on this page.
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="stock-picker-title"
        className="border-line bg-panel text-text fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-md rounded-2xl border p-5 shadow-xl backdrop:bg-black/50"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="stock-picker-title" className="text-xl font-medium">
            Select a stock
          </h2>
          <button
            type="button"
            aria-label="Close stock picker"
            onClick={() => dialog.current?.close()}
            className="px-3 py-2"
          >
            ×
          </button>
        </div>
        <label className="text-muted block text-xs">
          Search stocks or issuers
          <input
            autoFocus
            className="border-line bg-bg text-text mt-2 w-full rounded-xl border p-3 text-sm"
            placeholder="Name, ticker, issuer or mint"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <p className="text-dim mt-3 text-xs">
          Issuer metadata only; swap support is unavailable.
        </p>
        <div className="max-h-[48dvh] overflow-y-auto">
          {filteredAssets.map((a) => (
            <button
              type="button"
              key={a.mint}
              onClick={() => {
                setSelected(a.mint);
                dialog.current?.close();
              }}
              className="border-line hover:bg-panel-2 flex w-full items-center gap-3 border-b py-3 text-left"
            >
              <TokenMark symbol={a.symbol} />
              <span>
                <span className="block font-medium">{a.symbol}</span>
                <span className="text-muted text-xs">
                  {a.name} · {a.issuer}
                </span>
              </span>
            </button>
          ))}
          {!!assets.length && !filteredAssets.length && (
            <p role="status" className="text-muted py-6 text-sm">
              No matching stocks.
            </p>
          )}
          {!assets.length && (
            <p className="text-muted py-6 text-sm">
              No issuer assets are configured on this network.
            </p>
          )}
        </div>
      </dialog>
    </main>
  );
}
function TokenMark({ symbol }: { symbol?: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${symbol === "USDC" ? "bg-blue-600 text-white" : "bg-text text-bg"}`}
    >
      {symbol === "USDC" ? "$" : (symbol?.slice(0, 2) ?? "+")}
    </span>
  );
}
