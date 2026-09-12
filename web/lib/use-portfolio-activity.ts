"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { QUOTE_MINT } from "./deployment";
import {
  MANIFEST_PROGRAM_ID,
  MAGICBLOCK_DELEGATION_PROGRAM_ID,
  loadManifestMarket,
  manifestMarketPda,
  type RestingOrder,
} from "./manifest";
import { nMintPda, pMintPda, type LegName } from "./pdas";
import { useEphemeral } from "./rollup";
import { useSeries } from "./use-series";
import { useSigner } from "./use-signer";
import type { SeriesView } from "./series-types";
import { shared } from "./rpc-cache";
import { ordersBySide } from "./portfolio-orders";

/**
 * Everything the signer has going on outside their wallet.
 *
 * Positions answer "what do I own"; this answers the two questions the app had
 * no way to answer at all: "what orders do I have resting, and where", and
 * "how much of my money is sitting inside a live execution session rather than
 * in my wallet". Both are reconstructed from chain state, so a fresh browser on
 * another machine shows the same thing.
 *
 * # Why this enumerates rather than scans
 *
 * Markets are derived from canonical `SeriesRecord`s, never by scanning the
 * Manifest program's accounts. Creating a series is permissionless, so a scan
 * would surface books nobody vouched for beside the ones the registry lists.
 *
 * # Failure is per market
 *
 * One unreadable book must not blank the whole page. Each market carries its
 * own state, and the views render what they have.
 */
export type MarketLocation = "wallet" | "live";

export type OpenOrder = {
  market: PublicKey;
  series: SeriesView;
  leg: LegName;
  side: "buy" | "sell";
  price: number;
  /** Base tokens still resting. */
  remaining: number;
  /** What the order is holding, in the asset it is holding. */
  lockedAmount: number;
  lockedSymbol: string;
  sequence: bigint;
  /** Orders can only be cancelled while the book is delegated. */
  cancellable: boolean;
  raw: RestingOrder;
};

export type LiveBalance = {
  market: PublicKey;
  series: SeriesView;
  leg: LegName;
  /** Withdrawable inside the session, not in the wallet. */
  freeBase: number;
  freeQuote: number;
  /** Committed to resting orders. */
  lockedBase: number;
  lockedQuote: number;
  /** Whether an execution session currently holds the book. */
  sessionActive: boolean;
};

export type MarketProblem = { market: PublicKey; leg: LegName; message: string };

export type PortfolioActivity = {
  orders: OpenOrder[];
  balances: LiveBalance[];
  problems: MarketProblem[];
  loading: boolean;
  /** True while any market still holds funds inside a session. */
  fundsInSession: boolean;
  reload: () => void;
};

/** Bounded so a wide registry cannot open a hundred sockets at once. */
const CONCURRENCY = 4;

async function inBatches<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(run))));
  }
  return out;
}

const asNumber = (value: unknown) => Number(String(value));

export function usePortfolioActivity(): PortfolioActivity {
  const signer = useSigner();
  const { connection: l1 } = useConnection();
  const { connection: rollup } = useEphemeral();
  const { state: seriesState } = useSeries();
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [balances, setBalances] = useState<LiveBalance[]>([]);
  const [problems, setProblems] = useState<MarketProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const series = useMemo(
    () => (seriesState.kind === "ready" ? seriesState.series : []),
    [seriesState],
  );

  const load = useCallback(async () => {
    if (!signer || !series.length) {
      setOrders([]);
      setBalances([]);
      setProblems([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    // Both legs of every canonical series. P is advanced to trade but a
    // position in it is just as real, and leaving it out would understate
    // what someone holds.
    const targets = series.flatMap((view) =>
      (["N", "P"] as LegName[]).map((leg) => ({
        view,
        leg,
        market: manifestMarketPda(
          leg === "N" ? nMintPda(view.address) : pMintPda(view.address),
          QUOTE_MINT,
          MANIFEST_PROGRAM_ID,
        ),
      })),
    );

    const nextOrders: OpenOrder[] = [];
    const nextBalances: LiveBalance[] = [];
    const nextProblems: MarketProblem[] = [];

    await inBatches(targets, CONCURRENCY, async ({ view, leg, market }) => {
      try {
        // One owner read decides which chain holds the book, and it is shared
        // with everything else asking the same question this second.
        const info = await shared(
          `owner:${market.toBase58()}`,
          10_000,
          () => l1.getAccountInfo(market),
        );
        if (!info) return;

        const delegated = info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID);
        const { market: book } = await loadManifestMarket(
          delegated ? rollup : l1,
          market,
          MANIFEST_PROGRAM_ID,
        );

        const held = book.getBalances(signer);
        const free = {
          base: held.baseWithdrawableBalanceTokens,
          quote: held.quoteWithdrawableBalanceTokens,
          lockedBase: held.baseOpenOrdersBalanceTokens,
          lockedQuote: held.quoteOpenOrdersBalanceTokens,
        };

        if (free.base || free.quote || free.lockedBase || free.lockedQuote) {
          nextBalances.push({
            market,
            series: view,
            leg,
            freeBase: free.base,
            freeQuote: free.quote,
            lockedBase: free.lockedBase,
            lockedQuote: free.lockedQuote,
            sessionActive: delegated,
          });
        }

        for (const { order, side } of ordersBySide(book.bids(), book.asks())) {
          if (!order.trader.equals(signer)) continue;
          const size = asNumber(order.numBaseTokens);
          const isBid = side === "buy";
          nextOrders.push({
            market,
            series: view,
            leg,
            side,
            price: order.tokenPrice,
            remaining: size,
            // A bid reserves cash; an ask reserves the claim itself.
            lockedAmount: isBid ? order.tokenPrice * size : size,
            lockedSymbol: isBid ? "USDC" : leg,
            sequence: BigInt(order.sequenceNumber.toString()),
            cancellable: delegated,
            raw: order,
          });
        }
      } catch (error) {
        nextProblems.push({
          market,
          leg,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    setOrders(
      nextOrders.sort((a, b) => (a.sequence === b.sequence ? 0 : a.sequence > b.sequence ? -1 : 1)),
    );
    setBalances(nextBalances);
    setProblems(nextProblems);
    setLoading(false);
  }, [l1, rollup, series, signer]);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  return {
    orders,
    balances,
    problems,
    loading,
    fundsInSession: balances.some(
      (entry) =>
        entry.sessionActive &&
        (entry.freeBase > 0 || entry.freeQuote > 0 || entry.lockedBase > 0 || entry.lockedQuote > 0),
    ),
    reload: () => setNonce((value) => value + 1),
  };
}
