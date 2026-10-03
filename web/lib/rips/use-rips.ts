"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { rollupValidator } from "../actions";
import { QUOTE_MINT } from "../deployment";
import { IS_DEVNET } from "../network-config";
import {
  MANIFEST_PROGRAM_ID,
  OrderType,
  delegateManifestTokensIxs,
  loadManifestMarket,
  manifestDepositIxs,
  manifestMarketPda,
  manifestOrderIx,
} from "../manifest";
import { nMintPda } from "../pdas";
import { usePrograms } from "../programs";
import { useEphemeral } from "../rollup";
import { planOrderSteps } from "../transaction-flow";
import { useSeries } from "../use-series";
import { useSigner } from "../use-signer";
import { useTransactionFlow, type FlowPlan } from "../use-transaction-flow";
import { demoLots, demoMark } from "./demo";
import { describeSeries, loadLiveBook, lotFromBook, type LiveBook } from "./live";
import {
  addFill,
  fillFromAsks,
  mergeLive,
  totalPaid,
  totalQty,
  type ChainFill,
  type PoolLot,
  type RipFill,
  type RipPosition,
  type RipSource,
  type SeriesInfo,
} from "./model";
import { loadRipPurchases, type ChainPurchase } from "./history";
import { positionsKey, useDemoConsumed, useStoredPositions } from "./store";

const nowSecs = () => Math.floor(Date.now() / 1000);

/** A clock that ticks, so marks and countdowns move without a reload. */
export function useNow(intervalMs = 2_000) {
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    const t = window.setInterval(() => setNow(nowSecs()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Live or demo. Mainnet is always live: there is no simulated inventory beside
 * real funds. Test networks default to the demo pool until live inventory
 * exists, and the choice is a per-viewer convenience.
 */
const MODE_KEY = "erodoro.rips.mode";
export function useRipMode(liveAvailable: boolean, liveState: LivePoolState) {
  const [chosen, setChosen] = useState<RipSource | null>(null);
  // The default when the viewer has not chosen. Decided once, after the pool
  // has been read, and then held: deciding before the read and correcting
  // after it flipped the page under a finger already on the button.
  const [implicit, setImplicit] = useState<RipSource | null>(null);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(MODE_KEY);
      if (v === "live" || v === "demo") setChosen(v);
    } catch {
      // Default below.
    }
  }, []);
  useEffect(() => {
    if (implicit || liveState === "loading") return;
    setImplicit(liveAvailable ? "live" : "demo");
  }, [implicit, liveAvailable, liveState]);
  const resolved: RipSource | null = !IS_DEVNET ? "live" : (chosen ?? implicit);
  const setMode = useCallback((m: RipSource) => {
    setChosen(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // Session-only.
    }
  }, []);
  return { mode: resolved ?? "demo", ready: resolved !== null, setMode, canSwitch: IS_DEVNET };
}

export type LivePoolState = "loading" | "ready" | "undeployed" | "error";

/** Everything currently on offer, live and (on test networks) demo. */
export function useRipPool() {
  const { state: series } = useSeries();
  const { connection: l1 } = useConnection();
  const { connection: rollup } = useEphemeral();
  const { oracle } = usePrograms();
  const now = useNow();
  const { consumed } = useDemoConsumed();
  const [books, setBooks] = useState<LiveBook[]>([]);
  const [loaded, setLoaded] = useState(false);

  const views = series.kind === "ready" ? series.series : null;
  const refresh = useCallback(async () => {
    if (!views) return;
    const read = await Promise.all(views.map((v) => loadLiveBook(v, l1, rollup, oracle)));
    setBooks(read.filter((b): b is LiveBook => b !== null));
    setLoaded(true);
  }, [views, l1, rollup, oracle]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Only books this signer can actually trade on. Without a seat every fill
  // would be rejected, so offering the lot would be offering a guaranteed
  // failure. With no signer yet, show the whole pool.
  const signer = useSigner();
  const liveLots = useMemo(
    () =>
      books
        .filter((b) => !signer || b.hasSeat(signer))
        .map((b) => lotFromBook(b, now))
        .filter((l): l is PoolLot => l !== null),
    [books, now, signer],
  );
  const demo = useMemo(() => (IS_DEVNET ? demoLots(now, consumed) : []), [now, consumed]);

  const liveState: LivePoolState =
    series.kind === "undeployed"
      ? "undeployed"
      : series.kind === "error"
        ? "error"
        : series.kind === "loading" || !loaded
          ? "loading"
          : "ready";

  return { liveLots, demoLots: demo, books, liveState, refresh, now };
}

export function useRipPositions(mode: RipSource) {
  const signer = useSigner();
  const key = positionsKey(signer?.toBase58() ?? null, mode === "demo");
  return { ...useStoredPositions(key), signer };
}

export type Mark = { value: number; spot: number | null; marked: "model" | "bid" | "cost" };

/**
 * What each position is worth now.
 *
 * Live positions are marked at the best bid -- what could actually be sold
 * for -- and fall back to cost, labelled as such, when nobody is bidding.
 * Demo positions use the simulation's model value.
 */
export function useMarks(positions: RipPosition[], books: LiveBook[], now: number) {
  return useMemo(() => {
    const bySeries = new Map(books.map((b) => [b.view.address.toBase58(), b]));
    const marks = new Map<string, Mark>();
    for (const p of positions) {
      const qty = totalQty(p);
      if (p.source === "demo") {
        const m = demoMark(p.symbol, p.strike, p.expiryTs, now);
        marks.set(p.id, { value: m.value * qty, spot: m.spot, marked: "model" });
        continue;
      }
      const book = p.series ? bySeries.get(p.series) : undefined;
      if (book?.bestBid) {
        marks.set(p.id, { value: book.bestBid * qty, spot: book.spot, marked: "bid" });
      } else {
        marks.set(p.id, { value: totalPaid(p), spot: book?.spot ?? null, marked: "cost" });
      }
    }
    return marks;
  }, [positions, books, now]);
}

/** This signer's Rip purchases from the chain; re-read on demand after a buy. */
export function useRipHistory(mode: RipSource) {
  const signer = useSigner();
  const { connection: rollup } = useEphemeral();
  const [purchases, setPurchases] = useState<ChainPurchase[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    if (mode !== "live" || !signer) {
      setPurchases([]);
      setLoaded(true);
      return;
    }
    try {
      setPurchases(await loadRipPurchases(rollup, signer));
    } catch {
      // Local records still show; the next refresh retries.
    } finally {
      setLoaded(true);
    }
  }, [mode, rollup, signer]);
  useEffect(() => {
    setLoaded(false);
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);
  return { purchases, loaded, refresh };
}

/**
 * Live positions: Rip purchases from the chain merged with this browser's
 * records, capped at what the wallet still holds. Demo positions pass through.
 */
export function useLivePositions(
  recorded: RipPosition[],
  purchases: ChainPurchase[],
  books: LiveBook[],
  mode: RipSource,
  now: number,
) {
  const signer = useSigner();
  return useMemo(() => {
    if (mode !== "live") return recorded;
    const byMarket = new Map(books.map((b) => [b.market.toBase58(), b]));
    const chain: ChainFill[] = [];
    for (const p of purchases) {
      const book = byMarket.get(p.market);
      if (!book) continue;
      chain.push({
        series: book.view.address.toBase58(),
        qty: Number(p.baseAtoms) / 10 ** book.baseDecimals,
        paid: Number(p.quoteAtoms) / 10 ** book.quoteDecimals,
        at: p.at,
        signature: p.signature,
      });
    }
    const info = new Map<string, SeriesInfo>(
      books.map((b) => [b.view.address.toBase58(), { ...describeSeries(b.view), spot: b.spot }]),
    );
    const held = new Map<string, number>(
      signer ? books.map((b) => [b.view.address.toBase58(), b.heldBy(signer)]) : [],
    );
    return mergeLive(recorded, chain, info, held, now);
  }, [recorded, purchases, books, mode, now, signer]);
}

export type BuyResult =
  | { ok: true; position: RipPosition; fill: RipFill }
  | { ok: false; reason: string; cancelled?: boolean };

/**
 * Buy into a lot: a $1 Rip, or a deliberate top-up of a position.
 *
 * Demo buys settle instantly against the simulation. Live buys run the same
 * composed flow the trading ticket uses -- move USDC into the live session if
 * needed, then claim a seat, deposit and place the order -- but the order is
 * immediate-or-cancel at the worst price the walk touched, so a Rip either
 * fills now or leaves nothing resting on the book.
 */
export function useRipBuy(mode: RipSource) {
  const { positions, save, signer } = useRipPositions(mode);
  const { consume } = useDemoConsumed();
  const { connection: l1 } = useConnection();
  const { connection: rollup } = useEphemeral();
  const flow = useTransactionFlow("rip");
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const record = useCallback(
    (lot: PoolLot, fill: RipFill) => {
      const { positions: next, position } = addFill(positionsRef.current, lot, fill);
      save(next);
      return position;
    },
    [save],
  );

  const buy = useCallback(
    async (lot: PoolLot, budget: number, kind: RipFill["kind"]): Promise<BuyResult> => {
      if (lot.source === "demo") {
        // A short beat so the reveal has something to anticipate.
        await new Promise((r) => window.setTimeout(r, 260));
        const qty = budget / lot.askPrice;
        consume(lot.id, budget);
        const fill: RipFill = { kind, qty, paid: budget, at: Date.now() };
        return { ok: true, position: record(lot, fill), fill };
      }

      if (!signer) return { ok: false, reason: "Connect a wallet to Rip." };
      if (!lot.series) return { ok: false, reason: "This lot has no market." };
      const baseMint = nMintPda(new PublicKey(lot.series));
      const market = manifestMarketPda(baseMint, QUOTE_MINT, MANIFEST_PROGRAM_ID);

      let before = 0;
      let quoteBefore = 0;
      let deposited = 0;
      let signature: string | undefined;
      let planned = { qty: 0, cost: 0, limit: 0 };

      const plan = async (): Promise<FlowPlan> => {
        const { market: live } = await loadManifestMarket(rollup, market, MANIFEST_PROGRAM_ID);
        const asks = live.asks().map((o) => ({
          price: o.tokenPrice,
          size: Number(String(o.numBaseTokens)),
        }));
        const baseDecimals = live.baseDecimals();
        const quoteDecimals = live.quoteDecimals();
        if (!live.hasSeat(signer)) {
          // Claiming one is refused while the session is active.
          throw new Error("Your wallet has no trading seat on this market, so it can’t buy here yet.");
        }
        planned = fillFromAsks(asks, budget, 10 ** -baseDecimals);
        if (planned.qty <= 0) throw new Error("This lot just sold out. Rip again.");
        const held = live.getBalances(signer);
        before = held.baseWithdrawableBalanceTokens;
        quoteBefore = held.quoteWithdrawableBalanceTokens;
        const quoteNeeded = Math.max(0, planned.cost - quoteBefore);
        // Round up to the next atom so the deposit always covers the walk.
        const quoteAtoms = BigInt(Math.ceil(quoteNeeded * 10 ** quoteDecimals));
        deposited = Number(quoteAtoms) / 10 ** quoteDecimals;

        const steps = planOrderSteps({
          claimDeficit: 0,
          baseToDelegate: BigInt(0),
          quoteToDelegate: quoteAtoms,
          baseSymbol: lot.symbol,
          collateralSymbol: "USDC",
        });

        const execute: FlowPlan["execute"] = async (step, send) => {
          if (step.kind === "delegate") {
            const validator = await rollupValidator();
            return send(async () =>
              delegateManifestTokensIxs({
                connection: l1,
                payer: signer,
                mint: QUOTE_MINT,
                amountAtoms: quoteAtoms,
                validator,
              }),
            );
          }
          if (step.kind === "project") {
            const account = getAssociatedTokenAddressSync(QUOTE_MINT, signer);
            for (let i = 0; i < 40; i += 1) {
              try {
                const amount = BigInt(
                  (await rollup.getTokenAccountBalance(account, "confirmed")).value.amount,
                );
                if (amount >= quoteAtoms) return null;
              } catch {
                // Projection is asynchronous.
              }
              await new Promise((r) => window.setTimeout(r, 250));
            }
            throw new Error("The delegated balance did not appear on MagicBlock in time.");
          }
          const sent = await send(async () => {
            const ixs: TransactionInstruction[] = [];
            ixs.push(
              ...manifestDepositIxs({
                payer: signer,
                market,
                baseMint,
                quoteMint: QUOTE_MINT,
                baseAtoms: BigInt(0),
                quoteAtoms,
                hasSeat: true,
                programId: MANIFEST_PROGRAM_ID,
              }),
              manifestOrderIx({
                payer: signer,
                market,
                tokenPrice: planned.limit,
                baseTokens: planned.qty,
                baseDecimals,
                quoteDecimals,
                isBid: true,
                orderType: OrderType.ImmediateOrCancel,
                programId: MANIFEST_PROGRAM_ID,
              }),
            );
            return ixs;
          }, rollup);
          signature = sent ?? undefined;
          return sent;
        };
        return { steps, execute };
      };

      const ok = await flow.start(plan);
      if (!ok) return { ok: false, reason: "The purchase did not complete." };

      // What actually filled, read back rather than assumed: another buyer
      // can take the same offers between the walk and the match.
      const { market: after } = await loadManifestMarket(rollup, market, MANIFEST_PROGRAM_ID);
      const held = after.getBalances(signer);
      const qty = held.baseWithdrawableBalanceTokens - before;
      if (qty <= 0) {
        return {
          ok: false,
          reason: "Someone else took that inventory first. Nothing was bought; your USDC stays in your trading balance.",
        };
      }
      // Paid is the USDC that left the trading balance, not the planned cost.
      const spent = quoteBefore + deposited - held.quoteWithdrawableBalanceTokens;
      const paid = spent > 0 ? spent : qty * (planned.cost / planned.qty);
      const fill: RipFill = { kind, qty, paid, at: Date.now(), signature };
      return { ok: true, position: record(lot, fill), fill };
    },
    [consume, flow, l1, record, rollup, signer],
  );

  return { buy, flow, signer };
}
