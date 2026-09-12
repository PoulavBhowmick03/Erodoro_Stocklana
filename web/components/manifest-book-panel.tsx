"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { rollupValidator } from "@/lib/actions";
import { fromRaw, toRaw } from "@/lib/format";
import {
  MANIFEST_PROGRAM_ID,
  Market,
  OrderType,
  claimManifestSeatIx,
  delegateManifestTokensIxs,
  loadManifestMarket,
  manifestCancelIx,
  manifestDepositIxs,
  manifestMarketPda,
  manifestOrderIx,
  type ManifestSession,
  type RestingOrder,
} from "@/lib/manifest";
import { QUOTE_MINT } from "@/lib/deployment";
import { nMintPda, pMintPda, type LegName } from "@/lib/pdas";
import { aggregateBookSide, type BookLevel, type BookSide } from "@/lib/order-book-levels";
import { useBookLocation, useEphemeral } from "@/lib/rollup";
import { useSend } from "@/lib/use-send";
import { useSigner } from "@/lib/use-signer";
import { useTokenBalances } from "@/lib/use-token-balances";
import {
  MAGICBLOCK_CREDIT,
  assertMagicBlockOrderRoute,
  executionStatus,
  orderMutationBlocker,
} from "@/lib/execution-policy";
import { claimLabel } from "@/lib/trading-ux";
import { describeApprovals, planOrderSteps, type FlowStep } from "@/lib/transaction-flow";
import { useTransactionFlow, type FlowPlan, type FlowSend } from "@/lib/use-transaction-flow";
import { useOrderDraft } from "@/lib/use-order-draft";
import { returnToParam, withReturnTo } from "@/lib/return-to";
import { describeFill, fillDestination, fillMessage, type FillOutcome } from "@/lib/fill-outcome";
import { useCapabilities } from "@/lib/use-capabilities";
import { can, whyNot } from "@/lib/capabilities";
import { TransactionProgress } from "./transaction-progress";
import {
  MarketPriceChart,
  OrderBookLadder,
  OrderTicket,
  ResponsiveMarketTicket,
  type TicketFunding,
  type TicketShortfall,
} from "./order-book-ui";
import { Button, EmptyState, Field, LiveDot, Segmented, Tabs, TxStatus } from "./ui";
import { useTour } from "./tour";
import type { Role } from "./role-toggle";

type ReadyState = {
  kind: "ready";
  market: Market;
  session: ManifestSession;
};
type State =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | ReadyState;

const asNumber = (value: unknown) => Number(String(value));
const sequence = (order: RestingOrder) =>
  BigInt(order.sequenceNumber.toString());

/**
 * Classic Manifest price-time ladder for one P/N leg.
 *
 * Value enters and leaves on Solana. Only core BatchUpdate instructions follow
 * the delegated market to MagicBlock, so the hot path remains a single
 * writable account with no wrapper/global-order CPIs.
 */
export function ManifestBookPanel({
  seriesAddress,
  leg,
  onLegChange,
  advanced = false,
  strike,
  expiry,
  intent,
  onIntentChange,
  mint,
}: {
  seriesAddress: PublicKey;
  leg: LegName;
  onLegChange: (leg: LegName) => void;
  advanced?: boolean;
  strike: number;
  expiry: number;
  intent: Role;
  onIntentChange: (role: Role) => void;
  /**
   * Locking collateral, offered inside the ticket when — and only when — the
   * composed order needs more of the claim than the signer holds.
   */
  mint?: {
    /** Instructions only; the order flow runs them as one of its steps. */
    buildSplit: (amount: number) => Promise<any>;
    blocked?: string;
    /** `null` until the balance has actually been read. */
    collateralAvailable: number | null;
    collateralSymbol: string;
  };
}) {
  const programId = MANIFEST_PROGRAM_ID;
  const publicKey = useSigner();
  const { connection: l1 } = useConnection();
  const { connection: rollup } = useEphemeral();
  const { state: tx, send, reset } = useSend();
  // Locking collateral, delegating balance and placing the order are one
  // action with up to three approvals. Pausing after the mint is deliberate:
  // it changes what the trader holds, and chaining straight into an order
  // would produce a second signature request they never separately agreed to.
  const order = useTransactionFlow(`${leg}-order`, { pauseAfter: ["mint"] });
  const { complete } = useTour();
  const { state: walletBalances } = useTokenBalances();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const orderSide: "buy" | "sell" = intent === "seller" ? "sell" : "buy";

  // What the trader typed survives a detour to go and get funds, and is
  // discarded the moment it becomes a real order.
  const draft = useOrderDraft(seriesAddress.toBase58(), leg);
  useEffect(() => {
    if (!draft.restored) return;
    setPrice(draft.restored.price);
    setSize(draft.restored.size);
    onIntentChange(draft.restored.side === "sell" ? "seller" : "buyer");
    // Only on the first restore for this market and leg; re-running would
    // fight the user every time they cleared a field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.restored]);

  useEffect(() => {
    draft.save({ side: orderSide, price, size });
  }, [draft, orderSide, price, size]);
  const [accountTab, setAccountTab] = useState<"orders" | "balances">(
    "orders",
  );
  const [marketTab, setMarketTab] = useState<"book" | "depth" | "activity">("book");
  // Bumped whenever the book writes into the ticket, so the ticket can flash
  // the fields it just changed. A silent prefill reads as a dead click.
  const [prefill, setPrefill] = useState(0);
  // What the last confirmed order actually did. "Confirmed" is not an outcome:
  // an order that crossed is a position, one that did not is a resting quote,
  // and they need different next steps.
  const [outcome, setOutcome] = useState<FillOutcome | null>(null);

  const quoteMint = QUOTE_MINT;
  const baseMint = useMemo(
    () => (leg === "P" ? pMintPda(seriesAddress) : nMintPda(seriesAddress)),
    [leg, seriesAddress],
  );
  const marketAddress = useMemo(
    () =>
      manifestMarketPda(baseMint, quoteMint, programId),
    [baseMint, programId, quoteMint],
  );
  const { location } = useBookLocation(
    marketAddress,
    programId ?? PublicKey.default,
  );
  const delegated = location.kind === "rollup";
  // What this deployment can do, from what has been read: whether the protocol
  // is on this cluster at all, and whether this book is in a live session.
  const capabilities = useCapabilities({ sessionActive: delegated });

  const load = useCallback(async () => {
    if (location.kind === "loading") {
      setState({ kind: "loading" });
      return;
    }
    if (location.kind === "error") {
      setState({ kind: "error", message: location.message });
      return;
    }
    if (location.kind === "absent") {
      setState({ kind: "absent" });
      return;
    }
    try {
      const loaded = await loadManifestMarket(
        location.kind === "rollup" ? rollup : l1,
        marketAddress,
        programId,
      );
      setState({ kind: "ready", ...loaded });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [l1, location.kind, marketAddress, programId, quoteMint, rollup]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!delegated) return;
    const timer = setInterval(() => void load(), 1_500);
    return () => clearInterval(timer);
  }, [delegated, load]);

  // These are hooks, so they must be reached on every render. Below the
  // early returns for the loading, error and absent states they were not,
  // and React counted a different number of hooks depending on whether the
  // market had loaded -- which is React error #310, and took the whole
  // market route down with it.
  /**
   * Read the chain, decide what this order still needs, and say so.
   *
   * Called again on every retry and continuation, which is what keeps a landed
   * prerequisite from being signed twice: a deficit that has been filled is no
   * longer observed, so it is no longer planned.
   */
  const planOrder = useCallback(
    async (isBid: boolean, tokenPrice: number, baseTokens: number): Promise<FlowPlan> => {
      assertMagicBlockOrderRoute(delegated);
      if (!publicKey) throw new Error("Connect a wallet or choose a demo account first.");

      // Fresh, not the render's snapshot. A retry after a partial failure has
      // to see what actually landed.
      const { market: live } = await loadManifestMarket(rollup, marketAddress, programId);
      const held = live.getBalances(publicKey);
      // Read off the fresh market rather than the render's snapshot: this
      // function now runs before the component knows the market has loaded.
      const liveBaseDecimals = live.baseDecimals();
      const liveQuoteDecimals = live.quoteDecimals();
      const walletNow = await l1
        .getTokenAccountBalance(getAssociatedTokenAddressSync(baseMint, publicKey), "confirmed")
        .then((result) => Number(result.value.uiAmount ?? 0))
        .catch(() => 0);

      const claimDeficit = isBid
        ? 0
        : Math.max(0, baseTokens - held.baseWithdrawableBalanceTokens - walletNow);

      // Minting resolves the shortfall, so delegation must account for the
      // claims this flow is about to create as well as the ones already held.
      const baseNeeded = isBid
        ? 0
        : Math.max(0, baseTokens - held.baseWithdrawableBalanceTokens);
      const quoteNeeded = isBid
        ? Math.max(0, tokenPrice * baseTokens - held.quoteWithdrawableBalanceTokens)
        : 0;
      const baseAtoms = BigInt(toRaw(baseNeeded.toFixed(liveBaseDecimals), liveBaseDecimals));
      const quoteAtoms = BigInt(toRaw(quoteNeeded.toFixed(liveQuoteDecimals), liveQuoteDecimals));

      const steps = planOrderSteps({
        claimDeficit,
        baseToDelegate: baseAtoms,
        quoteToDelegate: quoteAtoms,
        baseSymbol: leg,
        collateralSymbol: mint?.collateralSymbol ?? "collateral",
      });

      const execute = async (step: FlowStep, scopedSend: FlowSend) => {
        if (step.kind === "mint") {
          if (!mint) throw new Error("Locking collateral is not available for this market.");
          return scopedSend(() => mint.buildSplit(claimDeficit));
        }

        if (step.kind === "delegate") {
          const validator = await rollupValidator();
          const ixs: TransactionInstruction[] = [];
          for (const [asset, atoms] of [
            [baseMint, baseAtoms],
            [quoteMint, quoteAtoms],
          ] as const) {
            if (atoms === BigInt(0)) continue;
            ixs.push(
              ...(await delegateManifestTokensIxs({
                connection: l1,
                payer: publicKey,
                mint: asset,
                amountAtoms: atoms,
                validator,
              })),
            );
          }
          return scopedSend(async () => ixs);
        }

        if (step.kind === "project") {
          // Not a transaction. The delegation already landed on Solana; this
          // waits for MagicBlock to mirror it, and says so if it never does.
          for (const [asset, atoms] of [
            [baseMint, baseAtoms],
            [quoteMint, quoteAtoms],
          ] as const) {
            if (atoms === BigInt(0)) continue;
            const account = getAssociatedTokenAddressSync(asset, publicKey);
            let ready = false;
            for (let attempt = 0; attempt < 40; attempt += 1) {
              try {
                const amount = BigInt(
                  (await rollup.getTokenAccountBalance(account, "confirmed")).value.amount,
                );
                if (amount >= atoms) {
                  ready = true;
                  break;
                }
              } catch {
                // Projection is asynchronous; retry until the bounded deadline.
              }
              await new Promise((resolve) => window.setTimeout(resolve, 250));
            }
            if (!ready) {
              throw new Error("The delegated balance did not appear on MagicBlock in time.");
            }
          }
          return null;
        }

        return scopedSend(async () => {
          const ixs: TransactionInstruction[] = [];
          if (!live.hasSeat(publicKey)) {
            ixs.push(claimManifestSeatIx(publicKey, marketAddress, programId));
          }
          ixs.push(
            ...manifestDepositIxs({
              payer: publicKey,
              market: marketAddress,
              baseMint,
              quoteMint,
              baseAtoms,
              quoteAtoms,
              hasSeat: true,
              programId,
            }),
            manifestOrderIx({
              payer: publicKey,
              market: marketAddress,
              tokenPrice,
              baseTokens,
              baseDecimals: liveBaseDecimals,
              quoteDecimals: liveQuoteDecimals,
              isBid,
              orderType: OrderType.Limit,
              programId,
            }),
          );
          return ixs;
        }, rollup);
      };

      return { steps, execute };
    },
    [
      baseMint,
      delegated,
      l1,
      leg,
      marketAddress,
      mint,
      programId,
      publicKey,
      quoteMint,
      rollup,
    ],
  );

  /**
   * Only ever called after a confirmed flow. Nothing here is optimistic: the
   * book, the balances and the tour all follow chain state rather than the
   * assumption that the order landed.
   */
  const onOrderPlaced = useCallback(
    async (requested: number, before: Set<string>) => {
      // The draft became an order, so it is no longer a draft.
      draft.clear();

      // Read the book back rather than assuming the order rested. Only
      // sequences that were not there before belong to this order, so a
      // pre-existing order on the same market cannot be counted as this fill.
      let restingAfter = 0;
      try {
        const { market: live } = await loadManifestMarket(rollup, marketAddress, programId);
        for (const order of [...live.bids(), ...live.asks()]) {
          if (!publicKey || !order.trader.equals(publicKey)) continue;
          if (before.has(order.sequenceNumber.toString())) continue;
          restingAfter += Number(String(order.numBaseTokens));
        }
        setOutcome(describeFill({ requested, restingAfter }));
      } catch {
        // The order confirmed either way; only the description is unavailable.
        setOutcome(null);
      }

      await load();
      setMarketTab("activity");
      setAccountTab("orders");
      complete("act");
    },
    [complete, draft, load, marketAddress, programId, publicKey, rollup],
  );

  const unavailableWorkspace = (
    status: string,
    validation: string,
    content: ReactNode,
  ) => (
    <MarketWorkspace
      leg={leg}
      onLegChange={onLegChange}
      advanced={advanced}
      live={false}
      status={status}
      ticket={
        <OrderTicket
          side={orderSide}
          onSideChange={(next) => onIntentChange(next === "sell" ? "seller" : "buyer")}
          price={price}
          onPriceChange={setPrice}
          size={size}
          onSizeChange={setSize}
          baseSymbol={leg}
          quoteSymbol="USDC"
          availableBase={0}
          availableQuote={0}
          disabled
          validation={validation}
          onSubmit={() => {}}
          strike={strike}
          expiry={expiry}
        />
      }
    >
      <div className="p-4">{content}</div>
    </MarketWorkspace>
  );

  if (state.kind === "loading") {
    return unavailableWorkspace(
      "Loading Manifest market",
      "The market is still loading.",
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="bg-panel-2 h-8 animate-pulse rounded-sm" />
        ))}
      </div>,
    );
  }

  if (state.kind === "error") {
    /*
      A failed read has two very different causes, and they used to look
      identical. If the protocol is not on this cluster, every retry will fail
      the same way forever -- so the capability's reason replaces the raw error,
      and the button that cannot help is not offered.
    */
    const readWithheld = whyNot(capabilities, "trading.read");
    if (readWithheld) {
      return unavailableWorkspace(
        "Trading unavailable on this cluster",
        readWithheld,
        <EmptyState title="This market cannot be read here" body={readWithheld} />,
      );
    }
    return unavailableWorkspace(
      "Manifest read failed",
      "Retry the market read before placing an order.",
      <div className="border-danger/30 bg-danger/5 rounded-md border p-5">
        <h3 className="font-medium">Market could not be read</h3>
        <p className="text-danger mt-1 text-sm">{state.message}</p>
        <div className="mt-3">
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      </div>,
    );
  }

  if (state.kind === "absent") {
    return unavailableWorkspace(
      `Preparing live execution ${MAGICBLOCK_CREDIT}`,
      "This market is still being prepared.",
      <div data-tour="book">
        <EmptyState
          title={`The ${leg}/USDC market is opening`}
          body="Trading becomes available automatically once live execution is ready. Nothing to do — this page updates itself."
        />
      </div>,
    );
  }

  const { market } = state;
  const bids = market.bids();
  const asks = [...market.asks()];
  const baseDecimals = market.baseDecimals();
  const quoteDecimals = market.quoteDecimals();
  const balances = publicKey
    ? market.getBalances(publicKey)
    : {
        baseWithdrawableBalanceTokens: 0,
        quoteWithdrawableBalanceTokens: 0,
        baseOpenOrdersBalanceTokens: 0,
        quoteOpenOrdersBalanceTokens: 0,
      };
  const walletBase = walletBalances.kind === "ready"
    ? walletBalances.holdings
        .filter((holding) => holding.mint === baseMint.toBase58())
        .reduce((sum, holding) => sum + Number(fromRaw(holding.raw, holding.decimals, holding.decimals)), 0)
    : 0;
  const walletQuote = walletBalances.kind === "ready"
    ? walletBalances.holdings
        .filter((holding) => holding.mint === quoteMint.toBase58())
        .reduce((sum, holding) => sum + Number(fromRaw(holding.raw, holding.decimals, holding.decimals)), 0)
    : 0;
  const availableBase = balances.baseWithdrawableBalanceTokens + walletBase;
  const availableQuote = balances.quoteWithdrawableBalanceTokens + walletQuote;
  const busy = tx.kind === "sending";
  // One gate for duplicate submission, covering the whole composed flow rather
  // than only the transaction currently in the air.
  const flowBusy = busy || order.busy;
  const bidLevels = aggregateBookSide(
    bids.map((order) => ({
      price: order.tokenPrice,
      size: asNumber(order.numBaseTokens),
      order,
    })),
    "bid",
  );
  const askLevels = aggregateBookSide(
    asks.map((order) => ({
      price: order.tokenPrice,
      size: asNumber(order.numBaseTokens),
      order,
    })),
    "ask",
  );
  const myOrders = publicKey
    ? [...asks, ...bids]
        .filter((order) => order.trader.equals(publicKey))
        .sort((a, b) => {
          const left = sequence(a);
          const right = sequence(b);
          return left === right ? 0 : left > right ? -1 : 1;
        })
    : [];
  const priceNumber = Number(price);
  const sizeNumber = Number(size);
  const validNumbers =
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
    : !validNumbers && (price || size)
        ? "Enter a price and size greater than zero."
        : orderSide === "buy" && validNumbers && priceNumber * sizeNumber > availableQuote
          ? undefined
          : orderSide === "sell" && validNumbers && sizeNumber > availableBase && !mint
            ? `Not enough ${leg} for this order.`
        : undefined;



  const selectLevel = (
    level: { price: number; size: number },
    side: BookSide,
  ) => {
    setPrice(String(level.price));
    setSize(String(level.size));
    // Clicking an ask means you want to take it, which is a buy.
    onIntentChange(side === "ask" ? "buyer" : "seller");
    setPrefill((count) => count + 1);
    reset();
  };

  /**
   * An empty side of the book: put the trader on that side of the ticket with
   * the quantity they can actually support, and leave the price to them. There
   * is no reference price to guess from on a market with no quotes, and
   * inventing one would be worse than an empty field.
   */
  const seedSide = (side: BookSide) => {
    const wantsToSell = side === "ask";
    onIntentChange(wantsToSell ? "seller" : "buyer");
    setSize(wantsToSell && availableBase > 0 ? String(availableBase) : "");
    setPrefill((count) => count + 1);
    reset();
  };

  /**
   * A sell order for more N than the signer holds is not an error — it is the
   * seller's ordinary starting position, and locking collateral is the step
   * that resolves it. Offering that step here, priced at the exact deficit,
   * turns a dead end into one click.
   */
  const deficit =
    orderSide === "sell" && validNumbers ? sizeNumber - availableBase : 0;
  /**
   * A sell order for more N than the signer holds is not an error -- it is the
   * seller's ordinary starting position. The ticket names the deficit so the
   * approval count is honest before anything is signed; locking runs as the
   * first step of the order flow rather than as a separate action.
   */
  /**
   * A buyer short of cash. This is not something the app can mint its way out
   * of, so it is stated rather than actioned -- with a way to go and fund on
   * devnet that comes back to this exact composed order.
   */
  const cashShort =
    orderSide === "buy" && validNumbers
      ? priceNumber * sizeNumber - availableQuote
      : 0;
  const funding: TicketFunding | undefined =
    cashShort > 1e-9
      ? {
          shortBy: cashShort,
          symbol: "USDC",
          /* Whether a funding route exists is a fact about this deployment, not
             about which network the bundle was built for. A devnet build served
             against a cluster that has no demo mint must not offer to send
             someone to a page that cannot mint them anything. */
          ...(can(capabilities, "demo.fixtures")
            ? {
                href: withReturnTo(
                  "/mint",
                  returnToParam(
                    "/trade/markets",
                    `?market=${seriesAddress.toBase58()}&view=${leg.toLowerCase()}`,
                  ),
                ),
                action: "Get demo USDC",
                note: "Your price and quantity are kept, and you come straight back here.",
              }
            : {
                note: `Fund the account with ${QUOTE_MINT.toBase58().slice(0, 4)}… , the quote asset this deployment settles against.`,
              }),
        }
      : undefined;

  const shortfall: TicketShortfall | undefined =
    mint && deficit > 1e-9
      ? {
          deficit,
          symbol: leg,
          collateralSymbol: mint.collateralSymbol,
          blocked:
            mint.blocked ??
            (mint.collateralAvailable !== null &&
            mint.collateralAvailable + 1e-9 < deficit
              ? `You hold ${mint.collateralAvailable.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${mint.collateralSymbol}, which is not enough to mint ${deficit.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg}.`
              : undefined),
        }
      : undefined;

  const cancelOrder = async (order: RestingOrder) => {
    assertMagicBlockOrderRoute(delegated);
    await send(
      async () => [
        manifestCancelIx(
          publicKey!,
          marketAddress!,
          sequence(order),
          programId,
        ),
      ],
      rollup,
    );
    await load();
  };

  return (
    <MarketWorkspace
      leg={leg}
      onLegChange={onLegChange}
      advanced={advanced}
      live={delegated}
      status={executionStatus(delegated)}
      tabs={
        <Tabs
          label="Market views"
          value={marketTab}
          onChange={setMarketTab}
          options={[
            { value: "book" as const, label: "Order book" },
            { value: "depth" as const, label: "Depth" },
            {
              value: "activity" as const,
              label: myOrders.length ? `My orders (${myOrders.length})` : "My activity",
            },
          ]}
        />
      }
      ticket={
        <>
          <OrderTicket
            side={orderSide}
            onSideChange={(next) => {
              onIntentChange(next === "sell" ? "seller" : "buyer");
              reset();
            }}
            price={price}
            onPriceChange={(value) => {
              setPrice(value);
              reset();
            }}
            size={size}
            onSizeChange={(value) => {
              setSize(value);
              reset();
            }}
            baseSymbol={leg}
            quoteSymbol="USDC"
            availableBase={availableBase}
            availableQuote={availableQuote}
            busy={flowBusy}
            highlight={prefill}
            shortfall={shortfall}
            funding={funding}
            approvals={
              validNumbers && !orderValidation && !shortfall?.blocked
                ? describeApprovals(
                    planOrderSteps({
                      claimDeficit: deficit > 1e-9 ? deficit : 0,
                      // Predicting the delegation from the balances already on
                      // screen keeps the count honest before the planner reads
                      // the chain; the planner is authoritative once it runs.
                      baseToDelegate:
                        orderSide === "sell" &&
                        sizeNumber > balances.baseWithdrawableBalanceTokens
                          ? BigInt(1)
                          : BigInt(0),
                      quoteToDelegate:
                        orderSide === "buy" &&
                        priceNumber * sizeNumber > balances.quoteWithdrawableBalanceTokens
                          ? BigInt(1)
                          : BigInt(0),
                      baseSymbol: leg,
                      collateralSymbol: mint?.collateralSymbol ?? "collateral",
                    }),
                  )
                : undefined
            }
            disabled={
              !publicKey ||
              flowBusy ||
              !validNumbers ||
              Boolean(orderValidation) ||
              Boolean(shortfall?.blocked) ||
              Boolean(funding)
            }
            validation={orderValidation}
            onSubmit={() => {
              if (!publicKey || flowBusy) return;
              const requested = sizeNumber;
              const before = new Set(myOrders.map((o) => o.sequenceNumber.toString()));
              setOutcome(null);
              void order
                .start(() => planOrder(orderSide === "buy", priceNumber, sizeNumber))
                .then((finished) => {
                  if (finished) void onOrderPlaced(requested, before);
                });
            }}
            strike={strike}
            expiry={expiry}
            outcome={
              outcome
                ? {
                    message: fillMessage(outcome, leg, orderSide),
                    destination: fillDestination(outcome),
                    kind: outcome.kind,
                  }
                : undefined
            }
            status={
              order.flow ? (
                <TransactionProgress
                  flow={order.flow}
                  continueLabel={orderSide === "sell" ? "Continue: place ask" : "Continue: place bid"}
                  onRetry={() => {
                    const requested = sizeNumber;
                    const before = new Set(myOrders.map((o) => o.sequenceNumber.toString()));
                    void order.resume().then((done) => {
                      if (done) void onOrderPlaced(requested, before);
                    });
                  }}
                  onContinue={() => {
                    const requested = sizeNumber;
                    const before = new Set(myOrders.map((o) => o.sequenceNumber.toString()));
                    void order.resume().then((done) => {
                      if (done) void onOrderPlaced(requested, before);
                    });
                  }}
                  onDismiss={() => {
                    setOutcome(null);
                    order.dismiss();
                  }}
                />
              ) : null
            }
          />
        </>
      }
    >
      <div className="p-3 sm:p-4">
        {marketTab === "book" && (
          <div data-tour="book">
            <MarketPriceChart
              marketKey={`${marketAddress!.toBase58()}.${leg}`}
              bestBid={bidLevels[0]?.price}
              bestAsk={askLevels[0]?.price}
              baseSymbol={leg}
              quoteSymbol="USDC"
            />
            <OrderBookLadder
              asks={askLevels}
              bids={bidLevels}
              baseSymbol={leg}
              quoteSymbol="USDC"
              live={delegated}
              onSelect={selectLevel}
              onSeed={seedSide}
            />
          </div>
        )}
        {marketTab === "depth" && <DepthChart asks={askLevels} bids={bidLevels} />}
        {marketTab === "activity" && (
          <AccountActivity
            connected={Boolean(publicKey)}
            tab={accountTab}
            onTabChange={setAccountTab}
            leg={leg}
            balances={balances}
            orders={myOrders}
            bids={bids}
            busy={busy}
            delegated={delegated}
            onCancel={cancelOrder}
            status={<TxStatus state={tx} />}
          />
        )}
      </div>
    </MarketWorkspace>
  );
}

/**
 * Book on the left, ticket on the right, one card each.
 *
 * The right rail used to be three separate cards — a leg selector, a mint form,
 * and the ticket — stacked with no relationship between them. Three panels
 * competing for the same corner made none of them read as the primary action.
 * The leg selector belongs with the book it selects, the mint form is now
 * contextual inside the ticket, and what remains on the right is the one thing
 * the trader came to fill in.
 */
function MarketWorkspace({
  leg,
  onLegChange,
  advanced,
  status,
  live,
  tabs,
  ticket,
  children,
}: {
  leg: LegName;
  onLegChange: (leg: LegName) => void;
  advanced: boolean;
  status: string;
  live: boolean;
  tabs?: ReactNode;
  ticket: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-market-workspace
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem]"
    >
      <section className="border-line bg-panel shadow-panel min-w-0 overflow-hidden rounded-md border">
        <div className="border-line-soft flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2.5">
          <div className="flex items-center gap-3">
            {advanced ? (
              <Segmented
                size="sm"
                label="Claim to trade"
                value={leg}
                onChange={onLegChange}
                options={[
                  { value: "N" as LegName, label: "N · Upside" },
                  { value: "P" as LegName, label: "P · Capped" },
                ]}
              />
            ) : (
              <h3 className="text-sm font-medium">
                {leg}/USDC
                <span className="text-dim ml-2 font-normal">{claimLabel(leg)}</span>
              </h3>
            )}
          </div>
          <div className="text-dim flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem]">
            <LiveDot live={live} />
            <span>{status}</span>
            {/* Stated here rather than only inside the ready-state book, so the
                venue is named while the market is still loading too. */}
            <span className="border-line rounded-sm border px-1.5 py-0.5 font-mono tracking-[0.06em] uppercase">
              Manifest {MAGICBLOCK_CREDIT}
            </span>
          </div>
        </div>
        {tabs}
        {children}
      </section>

      <ResponsiveMarketTicket label={claimLabel(leg)}>
        {/* The ticket names its own market. On mobile it opens as a sheet with
            no header above it, so without this the sheet says "Buy" without
            ever saying buy what. */}
        <div className="border-line bg-text text-bg flex items-center justify-between gap-2 rounded-md border px-3 py-2">
          <span className="text-sm font-medium">
            {claimLabel(leg)} ({leg})
          </span>
          <span className="font-mono text-[0.7rem] tracking-[0.1em] uppercase opacity-60">
            {leg}/USDC
          </span>
        </div>
        {ticket}
      </ResponsiveMarketTicket>
    </div>
  );
}

function DepthChart({
  asks,
  bids,
}: {
  asks: readonly BookLevel<unknown>[];
  bids: readonly BookLevel<unknown>[];
}) {
  const levels = [...bids, ...asks];
  if (!levels.length) {
    return (
      <div data-depth-chart className="border-line bg-panel rounded-md border px-6 py-20 text-center">
        <p className="text-muted text-sm">Depth appears when the first bid or ask is placed.</p>
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
  const x = (price: number) => padX + ((price - low) / (high - low)) * (width - padX * 2);
  const y = (total: number) => height - padY - (total / maxTotal) * (height - padY * 2);
  const points = (side: readonly BookLevel<unknown>[], reverse = false) =>
    (reverse ? [...side].reverse() : [...side])
      .map((level) => `${x(level.price).toFixed(1)},${y(level.total).toFixed(1)}`)
      .join(" ");

  return (
    <div data-depth-chart className="border-line bg-panel overflow-hidden rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Live market depth</h3>
          <p className="text-dim mt-0.5 text-xs">Cumulative size at each Manifest price level.</p>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="text-bid">● bids</span>
          <span className="text-ask">● asks</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Order-book depth chart">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gridY = padY + ratio * (height - padY * 2);
          return <line key={ratio} x1={padX} x2={width - padX} y1={gridY} y2={gridY} stroke="var(--chart-grid)" />;
        })}
        {bids.length > 0 && (
          <polyline points={points(bids, true)} fill="none" stroke="var(--color-bid)" strokeWidth="3" strokeLinejoin="round" />
        )}
        {asks.length > 0 && (
          <polyline points={points(asks)} fill="none" stroke="var(--color-ask)" strokeWidth="3" strokeLinejoin="round" />
        )}
        <text x={padX} y={height - 7} fill="var(--chart-label)" fontSize="12">{low.toFixed(2)}</text>
        <text x={width - padX} y={height - 7} textAnchor="end" fill="var(--chart-label)" fontSize="12">{high.toFixed(2)} USDC</text>
      </svg>
    </div>
  );
}

function AccountActivity({
  connected,
  tab,
  onTabChange,
  leg,
  balances,
  orders,
  bids,
  busy,
  delegated,
  onCancel,
  status,
}: {
  connected: boolean;
  tab: "orders" | "balances";
  onTabChange: (tab: "orders" | "balances") => void;
  leg: LegName;
  balances: {
    baseWithdrawableBalanceTokens: number;
    quoteWithdrawableBalanceTokens: number;
    baseOpenOrdersBalanceTokens: number;
    quoteOpenOrdersBalanceTokens: number;
  };
  orders: readonly RestingOrder[];
  bids: readonly RestingOrder[];
  busy: boolean;
  delegated: boolean;
  onCancel: (order: RestingOrder) => Promise<void>;
  /** Cancellation feedback, beside the orders it acts on. */
  status?: ReactNode;
}) {
  return (
    <div className="border-line overflow-hidden rounded-xl border">
      <div className="border-line flex border-b bg-panel-2 px-2 pt-1">
        {(["orders", "balances"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onTabChange(value)}
            className={`border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === value ? "border-accent text-text" : "border-transparent text-muted hover:text-text"
            }`}
          >
            {value === "orders" ? `Orders (${orders.length})` : "Balances"}
          </button>
        ))}
      </div>

      {!connected ? (
        <p className="text-dim px-4 py-10 text-center text-sm">Connect a wallet or choose a test key to see your activity.</p>
      ) : tab === "orders" ? (
        orders.length ? (
          <div className="overflow-x-auto">
            <div className="text-dim grid min-w-[32rem] grid-cols-4 bg-panel-2 px-4 py-2 text-[0.8125rem] tracking-[0.1em] uppercase">
              <span>Side</span><span>Price</span><span>Size</span><span className="text-right">Action</span>
            </div>
            {orders.map((order) => {
              const isBid = bids.includes(order);
              return (
                <div key={sequence(order).toString()} className="border-line-soft grid min-w-[32rem] grid-cols-4 items-center border-t px-4 py-2 font-mono text-xs">
              <span className={isBid ? "text-bid" : "text-ask"}>{isBid ? "Buy" : "Sell"}</span>
                  <span>{order.tokenPrice.toLocaleString()}</span>
                  <span>{asNumber(order.numBaseTokens).toLocaleString()}</span>
                  <span className="text-right">
                    <Button size="sm" disabled={busy || !delegated} onClick={() => void onCancel(order)}>Cancel</Button>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-dim px-4 py-10 text-center text-sm">No open orders for this signer.</p>
        )
      ) : (
        <div className="grid grid-cols-2 gap-5 p-4 sm:grid-cols-4">
          <Field label={`${leg} available`}>{balances.baseWithdrawableBalanceTokens}</Field>
          <Field label={`${leg} in orders`}>{balances.baseOpenOrdersBalanceTokens}</Field>
          <Field label="Cash available">{balances.quoteWithdrawableBalanceTokens}</Field>
          <Field label="Cash in orders">{balances.quoteOpenOrdersBalanceTokens}</Field>
        </div>
      )}
      {status && <div className="px-4 pb-3">{status}</div>}
    </div>
  );
}
