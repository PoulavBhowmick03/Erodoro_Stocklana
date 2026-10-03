/**
 * Live Rip inventory: the ask side of each listed series' N market.
 *
 * There is no separate Rip pool on chain and none is needed. A Rip is an
 * immediate-or-cancel buy against offers sellers already posted, so the
 * seller is paid by the same match that gives the buyer the claim, and the
 * offers consumed disappear from inventory for everyone.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";

import { QUOTE_MINT } from "../deployment";
import { fromRaw } from "../format";
import {
  MAGICBLOCK_DELEGATION_PROGRAM_ID,
  MANIFEST_PROGRAM_ID,
  loadManifestMarket,
  manifestMarketPda,
  type Market,
} from "../manifest";
import { marketProfileForCollateral } from "../market-profile";
import { decodeMagicBlockPrice, magicBlockPriceAddress } from "../magicblock-price";
import { marketAsset } from "../market-presentation";
import { nMintPda } from "../pdas";
import { decodePriceUpdateV2, scaleFromExpo } from "../pyth-codec.mjs";
import { shared } from "../rpc-cache";
import type { SeriesView } from "../series-types";
import type { AskLevel, PoolLot } from "./model";

export type LiveBook = {
  view: SeriesView;
  market: PublicKey;
  /** Orders can only be placed while the book is in a live session. */
  delegated: boolean;
  asks: AskLevel[];
  bestBid: number | null;
  spot: number | null;
  /**
   * Seats can only be claimed on Solana before a book is delegated
   * (docs/known-limitations.md), so a trader without one can never fill here.
   */
  hasSeat: (trader: PublicKey) => boolean;
  /** N claims a trader owns in this market, resting in orders included. */
  heldBy: (trader: PublicKey) => number;
};

export const strikeOf = (view: SeriesView) =>
  Number(fromRaw(view.config.strike, view.config.priceDecimals, view.config.priceDecimals));

export const nMarketOf = (view: SeriesView) =>
  manifestMarketPda(nMintPda(view.address), QUOTE_MINT, MANIFEST_PROGRAM_ID);

/** Underlying price from the same sources settlement and the markets table use. */
export async function readSpot(
  view: SeriesView,
  oracle: Program,
  rollup: Connection,
): Promise<number | null> {
  try {
    const profile = marketProfileForCollateral(view.config.collateralMint.toBase58());
    if (profile) {
      const address = magicBlockPriceAddress(profile.realtime);
      const info = await shared(`mb-price:${address.toBase58()}`, 2_000, () =>
        rollup.getAccountInfo(address, "confirmed"),
      );
      return info ? decodeMagicBlockPrice(info.data, profile.realtime.exponent).price : null;
    }
    const feedConfig = view.config.oracleAdapter;
    const raw = await shared<any>(`feed-config:${feedConfig.toBase58()}`, 30_000, () =>
      (oracle.account as any).feedConfig.fetchNullable(feedConfig),
    );
    if (!raw) return null;
    const source = raw.source as PublicKey;
    const info = await shared(`price:${source.toBase58()}`, 5_000, () =>
      oracle.provider.connection.getAccountInfo(source),
    );
    if (!info) return null;
    const update = decodePriceUpdateV2(Uint8Array.from(info.data));
    const [price, decimals] = scaleFromExpo(update.price, update.exponent);
    return Number(price) / 10 ** decimals;
  } catch {
    return null;
  }
}

function levels(market: Market, side: "asks" | "bids"): AskLevel[] {
  const orders = side === "asks" ? market.asks() : market.bids();
  return orders.map((o) => ({ price: o.tokenPrice, size: Number(String(o.numBaseTokens)) }));
}

/** One series' book, read from wherever it currently lives. */
export async function loadLiveBook(
  view: SeriesView,
  l1: Connection,
  rollup: Connection,
  oracle: Program,
): Promise<LiveBook | null> {
  const market = nMarketOf(view);
  const info = await l1.getAccountInfo(market).catch(() => null);
  if (!info) return null;
  const delegated = info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID);
  if (!delegated && !info.owner.equals(MANIFEST_PROGRAM_ID)) return null;
  try {
    const [{ market: loaded }, spot] = await Promise.all([
      loadManifestMarket(delegated ? rollup : l1, market, MANIFEST_PROGRAM_ID),
      readSpot(view, oracle, rollup),
    ]);
    const bids = levels(loaded, "bids");
    return {
      view,
      market,
      delegated,
      asks: levels(loaded, "asks"),
      bestBid: bids.length ? Math.max(...bids.map((b) => b.price)) : null,
      spot,
      hasSeat: (trader) => loaded.hasSeat(trader),
      heldBy: (trader) => {
        if (!loaded.hasSeat(trader)) return 0;
        const b = loaded.getBalances(trader);
        return b.baseWithdrawableBalanceTokens + b.baseOpenOrdersBalanceTokens;
      },
    };
  } catch {
    return null;
  }
}

/** How a series is named and pegged, for lots and for held positions alike. */
export function describeSeries(view: SeriesView) {
  const asset = marketAsset(view);
  // The devnet collateral's registry name is a disclaimer, not a name; the
  // Rip surfaces carry their own devnet labelling.
  const demoProfile = marketProfileForCollateral(view.config.collateralMint.toBase58());
  return {
    symbol: asset.symbol,
    name: demoProfile ? "SOL-linked demo token" : asset.name,
    strike: strikeOf(view),
    expiryTs: view.config.maturityTs.toNumber(),
  };
}

/** A book that can be ripped right now becomes a lot. */
export function lotFromBook(book: LiveBook, nowSecs: number): PoolLot | null {
  const { view } = book;
  const d = describeSeries(view);
  const open = "open" in view.config.status && !view.settlement && d.expiryTs > nowSecs + 3_600;
  if (!open || !book.delegated || book.asks.length === 0) return null;
  return {
    id: view.address.toBase58(),
    source: "live",
    ...d,
    spot: book.spot,
    askPrice: Math.min(...book.asks.map((a) => a.price)),
    availableUsd: book.asks.reduce((s, a) => s + a.price * a.size, 0),
    series: view.address.toBase58(),
  };
}
