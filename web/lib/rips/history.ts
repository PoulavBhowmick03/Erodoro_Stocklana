/**
 * Rip purchases, read back from the chain.
 *
 * Every Manifest match emits a `FillLog` in the transaction's program data,
 * and every order a `PlaceOrderLog` carrying its order type. A Rip (or a
 * Buy more) is the only thing in this app that buys N with an
 * immediate-or-cancel order -- the Pro ticket places limit orders -- so the
 * pair identifies Rip purchases exactly, with their real price and size,
 * whichever device made them.
 *
 * Event tags are keccak256(program id || event name)[0..8]. They are derived
 * here rather than hard-coded, because the deployed program is a fork with its
 * own id (the SDK's built-in tag is computed from upstream Manifest's).
 */

import { FillLog, OrderType, PlaceOrderLog } from "@bonasa-tech/manifest-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import type { Connection, PublicKey } from "@solana/web3.js";

import { ACTIVE_NETWORK } from "../network-config";
import { MANIFEST_PROGRAM_ID } from "../manifest";

const tag = (name: string) =>
  Buffer.from(keccak_256(Buffer.concat([MANIFEST_PROGRAM_ID.toBuffer(), Buffer.from(name)]))).subarray(0, 8).toString("hex");
const FILL = tag("manifest::logs::FillLog");
const PLACE = tag("manifest::logs::PlaceOrderLog");

/** One Rip purchase as the chain recorded it, in raw atoms. */
export type ChainPurchase = {
  signature: string;
  market: string;
  baseAtoms: string;
  quoteAtoms: string;
  at: number;
};

/** Parse one transaction's logs into the signer's Rip purchases (usually zero or one). */
export function purchasesFromLogs(
  logs: string[],
  signer: PublicKey,
  signature: string,
  blockTime: number | null | undefined,
): ChainPurchase[] {
  const fills: { market: string; base: bigint; quote: bigint }[] = [];
  let immediateBid = false;
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
    const kind = data.subarray(0, 8).toString("hex");
    try {
      if (kind === PLACE) {
        const log = PlaceOrderLog.deserialize(data.subarray(8))[0];
        if (log.trader.equals(signer) && log.isBid && log.orderType === OrderType.ImmediateOrCancel) {
          immediateBid = true;
        }
      } else if (kind === FILL) {
        const log = FillLog.deserialize(data.subarray(8))[0];
        if (log.taker.equals(signer) && log.takerIsBuy) {
          fills.push({
            market: log.market.toBase58(),
            base: BigInt(String(log.baseAtoms.inner)),
            quote: BigInt(String(log.quoteAtoms.inner)),
          });
        }
      }
    } catch {
      // A log this build cannot decode is not a Rip.
    }
  }
  if (!immediateBid) return [];
  const byMarket = new Map<string, { base: bigint; quote: bigint }>();
  for (const f of fills) {
    const t = byMarket.get(f.market) ?? { base: BigInt(0), quote: BigInt(0) };
    byMarket.set(f.market, { base: t.base + f.base, quote: t.quote + f.quote });
  }
  return [...byMarket].map(([market, t]) => ({
    signature,
    market,
    baseAtoms: t.base.toString(),
    quoteAtoms: t.quote.toString(),
    at: (blockTime ?? 0) * 1000,
  }));
}

type Cache = { newest: string | null; purchases: ChainPurchase[] };
const cacheKey = (signer: PublicKey) => `erodoro.rips.history.v1:${ACTIVE_NETWORK}:${signer.toBase58()}`;

function readCache(signer: PublicKey): Cache {
  try {
    const raw = window.localStorage.getItem(cacheKey(signer));
    if (raw) return JSON.parse(raw) as Cache;
  } catch {
    // Rebuilt from the chain below.
  }
  return { newest: null, purchases: [] };
}

function writeCache(signer: PublicKey, cache: Cache) {
  try {
    window.localStorage.setItem(cacheKey(signer), JSON.stringify(cache));
  } catch {
    // Only costs a re-read next time.
  }
}

/**
 * Every Rip purchase this signer has made, newest transactions fetched only.
 *
 * Signatures are immutable, so parsed results are cached by the newest one
 * seen and later loads fetch just what came after it.
 */
export async function loadRipPurchases(rollup: Connection, signer: PublicKey): Promise<ChainPurchase[]> {
  const cache = readCache(signer);
  const fresh: { signature: string; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const sigs = await rollup.getSignaturesForAddress(signer, {
      limit: 100,
      before,
      until: cache.newest ?? undefined,
    });
    fresh.push(...sigs.filter((s) => !s.err));
    if (sigs.length < 100) break;
    before = sigs[sigs.length - 1].signature;
  }
  if (fresh.length === 0) return cache.purchases;

  const found: ChainPurchase[] = [];
  for (let i = 0; i < fresh.length; i += 25) {
    const chunk = fresh.slice(i, i + 25);
    const txs = await rollup.getTransactions(
      chunk.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );
    txs.forEach((tx, j) => {
      if (!tx?.meta?.logMessages || tx.meta.err) return;
      found.push(...purchasesFromLogs(tx.meta.logMessages, signer, chunk[j].signature, tx.blockTime ?? chunk[j].blockTime));
    });
  }
  const known = new Set(cache.purchases.map((p) => `${p.signature}:${p.market}`));
  const next: Cache = {
    newest: fresh[0].signature,
    purchases: [...found.filter((p) => !known.has(`${p.signature}:${p.market}`)), ...cache.purchases],
  };
  writeCache(signer, next);
  return next.purchases;
}
