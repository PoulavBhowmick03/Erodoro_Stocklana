"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { usePrograms } from "@/lib/programs";
import { useEphemeral, useBookLocation } from "@/lib/rollup";
import { useSend } from "@/lib/use-send";
import { useSigner } from "@/lib/use-signer";
import { bookPda, marketPda, type LegName } from "@/lib/pdas";
import {
  cancelOrderIx,
  commitBookIx,
  delegateBookIx,
  depositIx,
  fillOrderIx,
  placeOrderIx,
  initBookIx,
  initMarketIx,
  undelegateBookIx,
  withdrawIx,
} from "@/lib/actions";
import { fromRaw, toRaw } from "@/lib/format";
import { QUOTE_MINT_KEY } from "@/lib/use-token-balances";
import {
  MAGICBLOCK_CREDIT,
  assertMagicBlockOrderRoute,
  executionStatus,
  orderMutationBlocker,
} from "@/lib/execution-policy";
import { useCapabilities } from "@/lib/use-capabilities";
import { claimDescription, claimLabel } from "@/lib/trading-ux";
import { MarketPriceChart, OrderTicket, ResponsiveMarketTicket } from "./order-book-ui";
import { AmountInput, Button, Field, Panel, TextInput, TxStatus } from "./ui";

/** P and N inherit the collateral's decimals; the quote mint is its own. */
const QUOTE_DECIMALS = 6;
type BookOrder = {
  id: BN;
  trader: number;
  isBid: boolean;
  price: BN;
  remaining: BN;
};

type BookState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** No market for the series at all. Nothing can trade until one exists. */
  | { kind: "noMarket" }
  /** Market exists, this leg has no book. Each leg is opened separately. */
  | { kind: "noBook"; market: any }
  | { kind: "ready"; market: any; book: any };

/**
 * The order book for one leg.
 *
 * This is the surface that makes the premium possible: N is only worth anything
 * if somebody can quote it, and quoting is only economic if updates are cheap.
 * Cheap is what the rollup is for.
 *
 * A delegated book lives on two chains. L1 still holds the account but the
 * delegation program owns it there, so it cannot be read through `market` and
 * every write bounces; the readable, writable copy is on the rollup. So both
 * the read and the order instructions follow the book to whichever chain
 * currently holds it.
 *
 * Deposits and withdrawals deliberately do not follow. They stay on L1 and fail
 * for as long as the session is open, because that gap is what stops the
 * rollup's ledger and the L1 vaults from disagreeing.
 */
export function BookPanel({
  seriesAddress,
  leg,
  onLegChange,
  maturityTs,
}: {
  seriesAddress: PublicKey;
  leg: LegName;
  onLegChange: (leg: LegName) => void;
  /** Needed to open the market, which records its own trading deadline. */
  maturityTs: BN;
}) {
  const publicKey = useSigner();
  const { market: marketProgram } = usePrograms();
  const { connection: erConnection, market: erMarket } = useEphemeral();
  const { state: tx, send, reset } = useSend();
  const [state, setState] = useState<BookState>({ kind: "loading" });

  const marketAddress = useMemo(() => marketPda(seriesAddress), [seriesAddress]);
  const bookAddress = useMemo(() => bookPda(marketAddress, leg), [marketAddress, leg]);
  const { location, recheck } = useBookLocation(bookAddress, marketProgram.programId);
  const delegated = location.kind === "rollup";
  const capabilities = useCapabilities({ sessionActive: delegated });

  const [base, setBase] = useState("");
  const [quote, setQuote] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [prefillSide, setPrefillSide] = useState<"buy" | "sell" | null>(null);
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [marketTab, setMarketTab] = useState<"book" | "depth" | "activity" | "info">("book");

  const load = useCallback(async () => {
    if (location.kind === "loading") return;
    if (location.kind === "error") {
      setState({ kind: "error", message: location.message });
      return;
    }

    // Market first, and separately from the book. Collapsing both into one
    // "absent" was what made this screen a dead end: it could not tell "this
    // series has no market" from "this leg has no book", so it offered neither
    // and explained nothing.
    let market: any;
    try {
      market = await (marketProgram.account as any).market.fetch(marketAddress);
    } catch {
      return setState({ kind: "noMarket" });
    }

    if (location.kind === "absent") return setState({ kind: "noBook", market });

    // The book is read from whichever chain owns it. `market` itself is never
    // delegated, so it is always read from L1.
    const reader = delegated ? erMarket : marketProgram;
    try {
      const book = await (reader.account as any).book.fetch(bookAddress);
      setState({ kind: "ready", market, book });
    } catch (error) {
      setState(
        delegated
          ? {
              kind: "error",
              message: `MagicBlock market read failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }
          : { kind: "noBook", market },
      );
    }
  }, [marketProgram, erMarket, delegated, location.kind, marketAddress, bookAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!delegated) return;
    // Inside a session the book moves at rollup speed, which is the entire
    // point of being in one. A ten-second poll would render it pointless.
    const id = setInterval(() => void load(), 1_500);
    return () => clearInterval(id);
  }, [delegated, load]);

  if (state.kind === "loading") {
    return (
      <UnavailableMarketWorkspace
        leg={leg}
        onLegChange={onLegChange}
        orderSide={orderSide}
        onOrderSideChange={setOrderSide}
        price={price}
        onPriceChange={setPrice}
        size={qty}
        onSizeChange={setQty}
        status="Loading market"
        validation="The market is still loading."
      >
        <div className="bg-panel-2 h-56 animate-pulse rounded-lg" />
      </UnavailableMarketWorkspace>
    );
  }

  if (state.kind === "error") {
    return (
      <UnavailableMarketWorkspace
        leg={leg}
        onLegChange={onLegChange}
        orderSide={orderSide}
        onOrderSideChange={setOrderSide}
        price={price}
        onPriceChange={setPrice}
        size={qty}
        onSizeChange={setQty}
        status="Trading temporarily unavailable"
        validation={`Orders remain read-only. ${state.message}`}
      >
        <div className="border-danger/30 bg-danger/5 rounded-xl border p-5">
          <h3 className="font-medium">Live market could not be reached</h3>
          <p className="text-muted mt-2 text-sm">
            No order will be rerouted to Solana. Your entered price and size are preserved.
          </p>
          <div className="mt-4">
            <Button onClick={() => void load()}>Retry</Button>
          </div>
        </div>
      </UnavailableMarketWorkspace>
    );
  }

  if (state.kind === "noMarket") {
    return (
      <UnavailableMarketWorkspace
        leg={leg}
        onLegChange={onLegChange}
        orderSide={orderSide}
        onOrderSideChange={setOrderSide}
        price={price}
        onPriceChange={setPrice}
        size={qty}
        onSizeChange={setQty}
        status="Market setup required"
        validation="Open the cash market before placing an order."
      >
        <OpenMarket
          connected={Boolean(publicKey)}
          seriesAddress={seriesAddress}
          maturityTs={maturityTs}
          busy={tx.kind === "sending"}
          state={tx}
          onOpen={async (quoteMint) => {
            if (!publicKey) return;
            await send(() => initMarketIx({ market: marketProgram, wallet: publicKey }, seriesAddress, quoteMint, maturityTs));
            await load();
          }}
        />
      </UnavailableMarketWorkspace>
    );
  }

  if (state.kind === "noBook") {
    return (
      <UnavailableMarketWorkspace
        leg={leg}
        onLegChange={onLegChange}
        orderSide={orderSide}
        onOrderSideChange={setOrderSide}
        price={price}
        onPriceChange={setPrice}
        size={qty}
        onSizeChange={setQty}
        status={`${leg} book setup required`}
        validation={`Open the ${leg} book before placing an order.`}
      >
        <div data-tour="book" className="border-line bg-panel-2 rounded-xl border p-5">
          <h3 className="font-medium">Open the {leg} order book</h3>
          <p className="text-muted mt-2 max-w-[62ch] text-sm">
            P and N trade independently. This side only needs to be opened once.
          </p>
          <div className="mt-4">
            <Button
              tone="accent"
              disabled={tx.kind === "sending" || !publicKey}
              onClick={async () => {
                if (!publicKey) return;
                await send(() => initBookIx({ market: marketProgram, wallet: publicKey }, seriesAddress, leg));
                await recheck();
                await load();
              }}
            >
              Open the {leg} book
            </Button>
          </div>
          {!publicKey && <p className="text-dim mt-3 text-xs">Connect a wallet or choose a test key to open it.</p>}
          <TxStatus state={tx} />
        </div>
      </UnavailableMarketWorkspace>
    );
  }

  const { market, book } = state;
  const baseDecimals: number = leg === "P" ? 8 : 8;
  const slot = publicKey
    ? book.slots.find((s: any) => s.occupied && s.owner.equals(publicKey))
    : null;

  // Order instructions are built against whichever client owns the book, so
  // the accounts they resolve belong to the chain they will be sent to.
  const tradeCtx = {
    market: erMarket,
    seriesAddress,
    marketAccount: market,
    leg,
    wallet: publicKey!,
  };
  // Deposits and withdrawals always build against L1, where the vaults live.
  const l1Ctx = { ...tradeCtx, market: marketProgram };

  const busy = tx.kind === "sending";

  // Keep the most competitive prices against the spread: the lowest ask is
  // the final row above it, and the highest bid is the first row below it.
  // Price-time priority remains visible within a price by putting older ids
  // closest to the spread as well.
  const asks = (book.orders as BookOrder[])
    .filter((o) => !o.isBid)
    .sort((a, b) => b.price.cmp(a.price) || b.id.cmp(a.id));
  const bids = (book.orders as BookOrder[])
    .filter((o) => o.isBid)
    .sort((a, b) => b.price.cmp(a.price) || a.id.cmp(b.id));
  const bestAsk = asks[asks.length - 1];
  const bestBid = bids[0];
  const spread = bestAsk && bestBid ? bestAsk.price.sub(bestBid.price) : null;
  const maxRemaining = (book.orders as BookOrder[]).reduce(
    (largest, o) => (o.remaining.gt(largest) ? o.remaining : largest),
    new BN(0),
  );

  const prefillOrder = (o: BookOrder) => {
    setPrice(fromRaw(o.price, QUOTE_DECIMALS, QUOTE_DECIMALS));
    setQty(fromRaw(o.remaining, baseDecimals, baseDecimals));
    const side = o.isBid ? "sell" : "buy";
    setPrefillSide(side);
    setOrderSide(side);
    reset();
  };

  /** Orders follow the book. */
  const order = async (build: () => Promise<any>) => {
    assertMagicBlockOrderRoute(delegated);
    await send(build, erConnection);
    await load();
  };
  /** Escrow movements never leave L1. */
  const escrow = async (build: () => Promise<any>) => {
    await send(build);
    await load();
    await recheck();
  };
  /**
   * Session control. `delegate` is an L1 instruction; `commit` and
   * `undelegate` are rollup instructions, because the state they act on lives
   * there. Ownership on L1 flips asynchronously after undelegation, so this
   * re-checks rather than assuming.
   */
  const session = async (build: () => Promise<any>, onRollup: boolean) => {
    await send(build, onRollup ? erConnection : undefined);
    await recheck();
    await load();
  };

  const availableBase = Number(fromRaw(slot?.baseFree ?? 0, baseDecimals));
  const availableQuote = Number(fromRaw(slot?.quoteFree ?? 0, QUOTE_DECIMALS));
  const priceNumber = Number(price);
  const sizeNumber = Number(qty);
  const validOrder =
    Number.isFinite(priceNumber) &&
    Number.isFinite(sizeNumber) &&
    priceNumber > 0 &&
    sizeNumber > 0;
  const executionBlocker = orderMutationBlocker({
    connected: Boolean(publicKey),
    capabilities,
  });
  const orderValidation = executionBlocker
    ? executionBlocker
    : !price || !qty
      ? "Enter a price and size."
      : !validOrder
        ? "Price and size must be greater than zero."
        : orderSide === "buy" && priceNumber * sizeNumber > availableQuote
          ? "Not enough free cash for this order."
          : orderSide === "sell" && sizeNumber > availableBase
            ? `Not enough free ${claimLabel(leg).toLowerCase()} for this order.`
        : undefined;
  const myOrders = publicKey
    ? (book.orders as BookOrder[]).filter((o) =>
        book.slots[o.trader]?.owner.equals(publicKey),
      )
    : [];

  return (
    <div className="space-y-4">
      <div className="border-n/30 bg-n/5 rounded-sm border px-4 py-3">
          <p className="text-n text-[0.88rem]">
            <span className={delegated ? "text-n font-medium" : "text-accent-ink font-medium"}>
              {executionStatus(delegated)}.
            </span>{" "}
            {delegated
              ? "Every order mutation is routed to the live execution market."
              : "The book stays visible, but placing, filling and cancelling are paused."}
          </p>
          {delegated && (
            <p className="text-dim mt-1.5 font-mono text-[0.8125rem] break-all">
              running on {location.kind === "rollup" ? location.owner.toBase58() : ""}
            </p>
          )}
        </div>

      <div
        data-market-workspace
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]"
      >
        <section className="border-line bg-panel min-w-0 overflow-hidden rounded-xl border">
          <div
            className="border-line flex overflow-x-auto border-b px-2 pt-2"
            role="tablist"
            aria-label="Market views"
          >
            {([
              ["book", "Order book"],
              ["depth", "Depth chart"],
              ["activity", "My activity"],
              ["info", "Market info"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={marketTab === value}
                onClick={() => setMarketTab(value)}
                className={`shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                  marketTab === value
                    ? "border-accent text-text"
                    : "border-transparent text-muted hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="p-3 sm:p-4">
            {marketTab === "book" && (
              <div data-tour="book">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-medium">{leg}/USDC order book</h3>
                    <p className="text-dim mt-0.5 text-xs">
                      {book.orders.length} open · {fromRaw(book.volumeBase, baseDecimals)} traded
                    </p>
                  </div>
                  <span className="border-line bg-panel-2 text-dim rounded-md border px-2 py-1 font-mono text-[0.8125rem] uppercase">
                    Price-time CLOB
                  </span>
                </div>
                <MarketPriceChart
                  marketKey={`${bookAddress.toBase58()}.${leg}`}
                  bestBid={bestBid ? Number(fromRaw(bestBid.price, QUOTE_DECIMALS)) : undefined}
                  bestAsk={bestAsk ? Number(fromRaw(bestAsk.price, QUOTE_DECIMALS)) : undefined}
                  baseSymbol={leg}
                  quoteSymbol="USDC"
                />
                <div data-orderbook-ladder className="overflow-hidden rounded-lg border border-line">
          <div className="text-dim grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_5.5rem] border-b border-line bg-panel-2 px-3 py-2 text-[0.8125rem] tracking-[0.1em] uppercase">
            <span>Price (USDC)</span>
            <span className="text-right">Size ({leg})</span>
            <span className="text-right">Action</span>
          </div>

          <div data-book-side="asks" aria-label="Sell orders">
            <div className="border-line-soft flex items-center justify-between border-b px-3 py-1.5">
              <span className="text-danger text-[0.8125rem] font-medium tracking-[0.12em] uppercase">Asks</span>
              <span className="text-dim text-[0.8125rem]">sellers</span>
            </div>
            {asks.length === 0 ? (
              <p className="text-dim border-line-soft border-b px-3 py-3 text-center text-[0.8rem]">No asks</p>
            ) : (
              asks.map((o) => (
                <OrderRow
                  key={o.id.toString()}
                  order={o}
                  baseDecimals={baseDecimals}
                  depth={maxRemaining.isZero() ? 0 : o.remaining.muln(100).div(maxRemaining).toNumber()}
                  canAct={Boolean(publicKey && delegated)}
                  mine={Boolean(publicKey && book.slots[o.trader]?.owner.equals(publicKey))}
                  busy={busy}
                  onPrefill={() => prefillOrder(o)}
                  onAction={() =>
                    order(() =>
                      publicKey && book.slots[o.trader]?.owner.equals(publicKey)
                        ? cancelOrderIx(tradeCtx, o.id)
                        : fillOrderIx(tradeCtx, o.id, o.remaining),
                    )
                  }
                />
              ))
            )}
          </div>

          <div
            data-book-spread
            className="border-line bg-panel-2 grid grid-cols-3 items-center border-y px-3 py-3 font-mono text-[0.78rem] tabular-nums"
          >
            <div>
              <span className="text-dim block font-sans text-[0.8125rem] tracking-[0.08em] uppercase">Best ask</span>
              <span className="text-danger">{bestAsk ? `$${fromRaw(bestAsk.price, QUOTE_DECIMALS, 2)}` : "—"}</span>
            </div>
            <div className="text-center">
              <span className="text-dim block font-sans text-[0.8125rem] tracking-[0.08em] uppercase">Spread</span>
              <span>
                {spread ? (spread.isNeg() ? "crossed" : `$${fromRaw(spread, QUOTE_DECIMALS, 2)}`) : "—"}
              </span>
            </div>
            <div className="text-right">
              <span className="text-dim block font-sans text-[0.8125rem] tracking-[0.08em] uppercase">Best bid</span>
              <span className="text-p">{bestBid ? `$${fromRaw(bestBid.price, QUOTE_DECIMALS, 2)}` : "—"}</span>
            </div>
          </div>

          <div data-book-side="bids" aria-label="Buy orders">
            <div className="border-line-soft flex items-center justify-between border-b px-3 py-1.5">
              <span className="text-p text-[0.8125rem] font-medium tracking-[0.12em] uppercase">Bids</span>
              <span className="text-dim text-[0.8125rem]">buyers</span>
            </div>
            {bids.length === 0 ? (
              <p className="text-dim px-3 py-3 text-center text-[0.8rem]">No bids</p>
            ) : (
              bids.map((o) => (
                <OrderRow
                  key={o.id.toString()}
                  order={o}
                  baseDecimals={baseDecimals}
                  depth={maxRemaining.isZero() ? 0 : o.remaining.muln(100).div(maxRemaining).toNumber()}
                  canAct={Boolean(publicKey && delegated)}
                  mine={Boolean(publicKey && book.slots[o.trader]?.owner.equals(publicKey))}
                  busy={busy}
                  onPrefill={() => prefillOrder(o)}
                  onAction={() =>
                    order(() =>
                      publicKey && book.slots[o.trader]?.owner.equals(publicKey)
                        ? cancelOrderIx(tradeCtx, o.id)
                        : fillOrderIx(tradeCtx, o.id, o.remaining),
                    )
                  }
                />
              ))
            )}
          </div>
                </div>
                <p className="text-dim mt-2 text-[0.75rem]">
                  {publicKey
                    ? "Select a level to prefill the matching order."
                    : "The market stays visible before you connect. Connect only when you are ready to trade."}
                </p>
              </div>
            )}

            {marketTab === "depth" && (
              <LegacyDepthChart asks={asks} bids={bids} baseDecimals={baseDecimals} leg={leg} />
            )}

            {marketTab === "activity" && (
              <div className="space-y-4">
                {!publicKey ? (
                  <div className="border-line bg-panel-2 rounded-xl border px-6 py-16 text-center">
                    <p className="text-muted text-sm">Connect a wallet or choose a test key to see your orders.</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field label={`${leg} free`}>{fromRaw(slot?.baseFree ?? 0, baseDecimals)}</Field>
                      <Field label={`${leg} in orders`}>{fromRaw(slot?.baseLocked ?? 0, baseDecimals)}</Field>
                      <Field label="Cash free">${fromRaw(slot?.quoteFree ?? 0, QUOTE_DECIMALS, 2)}</Field>
                      <Field label="Cash in orders">${fromRaw(slot?.quoteLocked ?? 0, QUOTE_DECIMALS, 2)}</Field>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-line">
                      <div className="border-line bg-panel-2 border-b px-3 py-2 text-sm font-medium">Open orders</div>
                      {myOrders.length ? myOrders.map((o) => (
                        <OrderRow
                          key={o.id.toString()}
                          order={o}
                          baseDecimals={baseDecimals}
                          depth={0}
                          canAct={delegated}
                          mine
                          busy={busy || !delegated}
                          onPrefill={() => prefillOrder(o)}
                          onAction={() => order(() => cancelOrderIx(tradeCtx, o.id))}
                        />
                      )) : <p className="text-dim px-4 py-8 text-center text-sm">No open orders.</p>}
                    </div>
                  </>
                )}
              </div>
            )}

            {marketTab === "info" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="border-line bg-panel-2 rounded-xl border p-5">
                  <div className="text-accent-ink font-mono text-[0.8125rem] tracking-[0.12em] uppercase">{leg} payoff</div>
                  <p className="text-muted mt-3 text-sm leading-6">
                    {leg === "N"
                      ? claimDescription("N")
                      : claimDescription("P")}
                  </p>
                </div>
                <div className="border-line bg-panel-2 rounded-xl border p-5">
                  <div className="text-dim font-mono text-[0.8125rem] tracking-[0.12em] uppercase">Execution</div>
                  <p className="text-muted mt-3 text-sm leading-6">
                    Price-time priority · {book.orders.length} open orders · {executionStatus(delegated)}.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <ResponsiveMarketTicket label={claimLabel(leg)}>
          <div className="border-line bg-panel rounded-xl border p-2">
            <div className="grid grid-cols-2 gap-1">
              {(["P", "N"] as LegName[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={leg === value}
                  onClick={() => onLegChange(value)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    leg === value ? "bg-panel-2 text-accent-ink" : "text-dim hover:text-text"
                  }`}
                >
                  <span>{claimLabel(value)}</span>
                  <span className="ml-1 text-[0.8125rem] font-normal">({value})</span>
                </button>
              ))}
            </div>
            <div className="border-line-soft text-dim mt-2 border-t px-2 pt-2 text-[0.8125rem]">
              <span className={delegated ? "text-n" : "text-accent-ink"}>{executionStatus(delegated)}</span>
            </div>
          </div>
          <OrderTicket
            side={orderSide}
            onSideChange={(next) => { setOrderSide(next); setPrefillSide(null); reset(); }}
            price={price}
            onPriceChange={(value) => { setPrice(value); setPrefillSide(null); reset(); }}
            size={qty}
            onSizeChange={(value) => { setQty(value); setPrefillSide(null); reset(); }}
            baseSymbol={leg}
            quoteSymbol="USDC"
            availableBase={availableBase}
            availableQuote={availableQuote}
            disabled={busy || !validOrder || Boolean(orderValidation)}
            validation={orderValidation ?? (prefillSide ? `Selected level: ready to ${prefillSide}.` : undefined)}
            onSubmit={() => {
              if (!publicKey || !validOrder) return;
              void order(() => placeOrderIx(
                tradeCtx,
                orderSide === "buy",
                new BN(toRaw(price, QUOTE_DECIMALS)),
                new BN(toRaw(qty, baseDecimals)),
              ));
            }}
            status={<TxStatus state={tx} />}
          />
        </ResponsiveMarketTicket>
      </div>

      {publicKey && (
        <details className="border-line bg-panel rounded-xl border">
          <summary className="hover:bg-panel-2/50 flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 transition-colors">
            <div>
              <h3 className="text-sm font-medium">Operator diagnostics</h3>
              <p className="text-dim mt-0.5 text-xs">Custody, checkpoint and emergency controls {MAGICBLOCK_CREDIT}.</p>
            </div>
            <span className="text-dim text-lg" aria-hidden="true">⌄</span>
          </summary>
          <div className="border-line grid gap-5 border-t p-4 lg:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium">Move assets</h4>
              <p className="text-dim mt-1 text-xs">
                {delegated ? "Paused while live execution is active." : "Prepare balances before activating this legacy book."}
              </p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label={`${leg} free`}>{fromRaw(slot?.baseFree ?? 0, baseDecimals)}</Field>
              <Field label={`${leg} in orders`}>{fromRaw(slot?.baseLocked ?? 0, baseDecimals)}</Field>
              <Field label="Cash free">${fromRaw(slot?.quoteFree ?? 0, QUOTE_DECIMALS, 2)}</Field>
              <Field label="Cash in orders">${fromRaw(slot?.quoteLocked ?? 0, QUOTE_DECIMALS, 2)}</Field>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <AmountInput label={`${leg} amount`} value={base} onChange={(v) => { setBase(v); reset(); }} suffix={leg} />
              <AmountInput label="Cash amount" value={quote} onChange={(v) => { setQuote(v); reset(); }} suffix="USDC" />
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                tone="accent"
                disabled={busy || delegated || (!base && !quote)}
                onClick={() =>
                  escrow(() =>
                    depositIx(l1Ctx, new BN(toRaw(base || "0", baseDecimals)), new BN(toRaw(quote || "0", QUOTE_DECIMALS))),
                  )
                }
              >
                Deposit
              </Button>
              <Button
                disabled={busy || delegated || (!base && !quote)}
                onClick={() =>
                  escrow(() =>
                    withdrawIx(l1Ctx, new BN(toRaw(base || "0", baseDecimals)), new BN(toRaw(quote || "0", QUOTE_DECIMALS))),
                  )
                }
              >
                Withdraw
              </Button>
            </div>
            </div>

            <div className="border-line-soft border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
              <h4 className="text-sm font-medium">Execution session {MAGICBLOCK_CREDIT}</h4>
              <p className="text-dim mt-1 text-xs">
                {delegated ? "All order mutations are running on MagicBlock." : "Activate the only supported order route."}
              </p>
            <div className="flex flex-wrap gap-2">
              {delegated ? (
                <>
                  <Button disabled={busy} onClick={() => session(() => commitBookIx(tradeCtx), true)}>
                    Save to Solana
                  </Button>
                  <Button
                    tone="accent"
                    disabled={busy}
                    onClick={() => session(() => undelegateBookIx(tradeCtx), true)}
                  >
                    Emergency settle to Solana
                  </Button>
                </>
              ) : (
                <Button
                  tone="accent"
                  disabled={busy}
                  onClick={() => session(() => delegateBookIx(l1Ctx), false)}
                >
                  Activate MagicBlock market
                </Button>
              )}
            </div>
            <p className="text-dim mt-3 text-[0.8rem]">
              {delegated
                ? "Emergency settlement ends trading, commits the book, and re-opens L1 withdrawals."
                : "Trading remains read-only until activation. Orders never fall back to Solana."}
            </p>
            </div>
            <div className="lg:col-span-2"><TxStatus state={tx} /></div>
          </div>
        </details>
      )}
    </div>
  );
}

function LegacyDepthChart({
  asks,
  bids,
  baseDecimals,
  leg,
}: {
  asks: BookOrder[];
  bids: BookOrder[];
  baseDecimals: number;
  leg: LegName;
}) {
  const cumulative = (orders: BookOrder[]) => {
    let total = 0;
    return orders.map((order) => {
      total += Number(fromRaw(order.remaining, baseDecimals));
      return {
        price: Number(fromRaw(order.price, QUOTE_DECIMALS)),
        total,
      };
    });
  };
  const bidDepth = cumulative(bids);
  const askDepth = cumulative([...asks].reverse());
  const levels = [...bidDepth, ...askDepth];

  if (!levels.length) {
    return (
      <div
        data-depth-chart
        className="border-line bg-panel-2 rounded-xl border px-6 py-20 text-center"
      >
        <p className="text-muted text-sm">
          Depth appears when the first bid or ask is placed.
        </p>
      </div>
    );
  }

  const width = 720;
  const height = 340;
  const padX = 44;
  const padY = 28;
  const prices = levels.map((level) => level.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(max - min, Math.max(max, 1) * 0.02);
  const low = min - range * 0.08;
  const high = max + range * 0.08;
  const maxTotal = Math.max(...levels.map((level) => level.total), 1);
  const x = (value: number) =>
    padX + ((value - low) / (high - low)) * (width - padX * 2);
  const y = (value: number) =>
    height - padY - (value / maxTotal) * (height - padY * 2);
  const points = (side: { price: number; total: number }[]) =>
    side
      .map(
        (level) =>
          `${x(level.price).toFixed(1)},${y(level.total).toFixed(1)}`,
      )
      .join(" ");

  return (
    <div
      data-depth-chart
      className="border-line bg-panel-2 overflow-hidden rounded-xl border p-3"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Live market depth</h3>
          <p className="text-dim mt-0.5 text-xs">
            Cumulative {leg} available at each price.
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="text-p">● bids</span>
          <span className="text-danger">● asks</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${leg} order-book depth chart`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gridY = padY + ratio * (height - padY * 2);
          return (
            <line
              key={ratio}
              x1={padX}
              x2={width - padX}
              y1={gridY}
              y2={gridY}
              stroke="var(--chart-grid)"
            />
          );
        })}
        {bidDepth.length > 0 && (
          <polyline
            points={points(bidDepth)}
            fill="none"
            stroke="rgb(32, 117, 91)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
        )}
        {askDepth.length > 0 && (
          <polyline
            points={points(askDepth)}
            fill="none"
            stroke="rgb(181, 59, 59)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
        )}
        <text
          x={padX}
          y={height - 7}
          fill="var(--chart-label)"
          fontSize="12"
        >
          {low.toFixed(2)}
        </text>
        <text
          x={width - padX}
          y={height - 7}
          textAnchor="end"
          fill="var(--chart-label)"
          fontSize="12"
        >
          {high.toFixed(2)} USDC
        </text>
      </svg>
    </div>
  );
}

function UnavailableMarketWorkspace({
  leg,
  onLegChange,
  orderSide,
  onOrderSideChange,
  price,
  onPriceChange,
  size,
  onSizeChange,
  status,
  validation,
  children,
}: {
  leg: LegName;
  onLegChange: (leg: LegName) => void;
  orderSide: "buy" | "sell";
  onOrderSideChange: (side: "buy" | "sell") => void;
  price: string;
  onPriceChange: (value: string) => void;
  size: string;
  onSizeChange: (value: string) => void;
  status: string;
  validation: string;
  children: ReactNode;
}) {
  return (
    <div
      data-market-workspace
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]"
    >
      <section className="border-line bg-panel min-w-0 overflow-hidden rounded-xl border">
        <div className="border-line flex border-b px-2 pt-2">
          <span className="border-accent text-text border-b-2 px-3 py-2.5 text-sm">
            Order book
          </span>
          <span className="text-dim px-3 py-2.5 text-sm">Depth chart</span>
          <span className="text-dim px-3 py-2.5 text-sm">My activity</span>
        </div>
        <div className="p-3 sm:p-4">{children}</div>
      </section>
      <ResponsiveMarketTicket label={claimLabel(leg)}>
        <div className="border-line bg-panel rounded-xl border p-2">
          <div className="grid grid-cols-2 gap-1">
            {(["P", "N"] as LegName[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={leg === value}
                onClick={() => onLegChange(value)}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  leg === value
                    ? "bg-panel-2 text-accent-ink"
                    : "text-dim hover:text-text"
                }`}
              >
                {value}
                <span className="ml-1 text-[0.8125rem] font-normal">
                  {claimLabel(value)} ({value})
                </span>
              </button>
            ))}
          </div>
          <div className="border-line-soft text-dim mt-2 border-t px-2 pt-2 text-[0.8125rem]">
            {status}
          </div>
        </div>
        <OrderTicket
          side={orderSide}
          onSideChange={onOrderSideChange}
          price={price}
          onPriceChange={onPriceChange}
          size={size}
          onSizeChange={onSizeChange}
          baseSymbol={leg}
          quoteSymbol="USDC"
          availableBase={0}
          availableQuote={0}
          disabled
          validation={validation}
          onSubmit={() => {}}
        />
      </ResponsiveMarketTicket>
    </div>
  );
}

function OrderRow({
  order,
  baseDecimals,
  depth,
  canAct,
  mine,
  busy,
  onPrefill,
  onAction,
}: {
  order: BookOrder;
  baseDecimals: number;
  depth: number;
  canAct: boolean;
  mine: boolean;
  busy: boolean;
  onPrefill: () => void;
  onAction: () => void;
}) {
  const side = order.isBid ? "bid" : "ask";
  const action = mine ? "Cancel" : "Fill";
  const shownPrice = fromRaw(order.price, QUOTE_DECIMALS, 2);
  const shownSize = fromRaw(order.remaining, baseDecimals);

  return (
    <div
      data-book-order={side}
      data-order-id={order.id.toString()}
      className="border-line-soft relative grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_5.5rem] items-stretch border-b last:border-b-0"
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 right-0 ${order.isBid ? "bg-p/10" : "bg-danger/10"}`}
        style={{ width: `${Math.max(0, Math.min(100, depth))}%` }}
      />
      <button
        type="button"
        onClick={onPrefill}
        className="hover:bg-panel-2/60 focus-visible:outline-accent relative col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] px-3 py-2 text-left transition-colors focus-visible:outline-1 focus-visible:outline-offset-[-1px]"
        aria-label={`Use ${side} at $${shownPrice} for size ${shownSize}`}
      >
        <span className={`font-mono text-[0.84rem] tabular-nums ${order.isBid ? "text-p" : "text-danger"}`}>
          ${shownPrice}
        </span>
        <span className="text-text text-right font-mono text-[0.84rem] tabular-nums">{shownSize}</span>
      </button>
      <div className="relative flex items-center justify-end px-2 py-1.5">
        {canAct ? (
          <Button size="sm" tone={mine ? "default" : "accent"} disabled={busy} onClick={onAction}>
            {action}
          </Button>
        ) : (
          <span className="text-dim pr-2">—</span>
        )}
      </div>
    </div>
  );
}

/**
 * Open the market for a series.
 *
 * Defaults to the cash mint made on the Test collateral page, because that is
 * where it came from and asking for it again would be asking the app to repeat
 * something it already knows. Editable, since a market can be quoted against
 * any classic-SPL mint.
 */
function OpenMarket({
  connected,
  seriesAddress,
  maturityTs,
  busy,
  state,
  onOpen,
}: {
  connected: boolean;
  seriesAddress: PublicKey;
  maturityTs: BN;
  busy: boolean;
  state: any;
  onOpen: (quoteMint: PublicKey) => Promise<void>;
}) {
  const [quote, setQuote] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    const saved = window.localStorage.getItem(QUOTE_MINT_KEY);
    if (saved) setQuote(saved);
  }, [loaded]);

  let key: PublicKey | null = null;
  try {
    key = quote ? new PublicKey(quote) : null;
  } catch {
    key = null;
  }

  return (
    <Panel
      tour="book"
      title="No market yet"
      subtitle="P and N exist, but there is nowhere to trade them until a market is opened."
    >
      <p className="text-muted max-w-[62ch] text-[0.9rem]">
        A market prices both sides against a cash token. Anyone can open one, it is not
        restricted to whoever made the series, and it only has to happen once.
      </p>

      <div className="mt-4 max-w-xl">
        <TextInput
          label="Cash mint"
          value={quote}
          onChange={(v) => setQuote(v.trim())}
          placeholder="Make test cash on the Test collateral page"
        />
        {quote && !key && <p className="text-danger mt-1.5 text-[0.8rem]">Not a valid address.</p>}
      </div>

      <div className="mt-4">
        <Button tone="accent" disabled={busy || !key || !connected} onClick={() => key && void onOpen(key)}>
          Open the market
        </Button>
      </div>

      <p className="text-dim mt-3 text-[0.8rem]">
        {connected
          ? "Must be a classic SPL mint. The Token-2022 collateral cannot be used here."
          : "Connect a wallet or choose a test key to open this market."}
      </p>

      <TxStatus state={state} />
    </Panel>
  );
}
