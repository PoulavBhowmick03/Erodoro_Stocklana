"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { usePrograms } from "./programs";
import { feedConfigPda } from "./pdas";
import { invalidate, shared } from "./rpc-cache";
// The decoder is plain JS so the build-time conformance gate
// (`scripts/check-oracle-decoder.mjs`) can check the exact module the app
// ships against the Rust golden vectors, rather than a second copy of it.
import { decodePriceUpdateV2, scaleFromExpo, formatQuote } from "./pyth-codec.mjs";

/**
 * A quote as the oracle adapter would hand it to `series::settle`.
 *
 * `price` is an integer carrying `decimals` decimal places, exactly as the
 * program reports it. It is deliberately not converted to a float here — the
 * settlement math is integer end to end, and a display layer that rounds
 * differently to the chain is how a UI ends up disagreeing with a payout.
 */
export type Quote = {
  feedId: Uint8Array;
  price: bigint;
  confidence: bigint;
  decimals: number;
  publishTime: number;
  /** Seconds between the publish time and the caller's clock. */
  ageSecs: number;
  /** True when `ageSecs` exceeds the feed config's own tolerance. */
  stale: boolean;
  verification: { kind: "full" } | { kind: "partial"; signatures: number };
};

export type FeedConfigView = {
  address: PublicKey;
  admin: PublicKey;
  feedId: Uint8Array;
  source: PublicKey;
  maxAgeSecs: number;
  minVerificationSignatures: number;
};

export type OracleState =
  | { kind: "loading" }
  | { kind: "undeployed" }
  | { kind: "unconfigured" }
  | { kind: "ready"; config: FeedConfigView; quote: Quote }
  | { kind: "error"; message: string; config?: FeedConfigView };

/**
 * Read the live quote behind a feed.
 *
 * The oracle adapter is the one part of the protocol deployed on devnet, so
 * this is the only path that can show real chain state today. It reads the same
 * two accounts `settle` reads, and applies the same checks, so a quote shown
 * here is a quote settlement would accept.
 */
export function useOracleQuote(feedId?: Uint8Array) {
  const { oracle } = usePrograms();
  const [state, setState] = useState<OracleState>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!feedId) {
      setState({ kind: "unconfigured" });
      return;
    }
    setState({ kind: "loading" });
    let config: FeedConfigView | undefined;
    try {
      const conn = oracle.provider.connection;

      const programInfo = await shared(
        `account:${oracle.programId.toBase58()}`,
        60_000,
        () => conn.getAccountInfo(oracle.programId),
      );
      if (!programInfo?.executable) {
        setState({ kind: "undeployed" });
        return;
      }

      const address = feedConfigPda(feedId);
      const raw = await shared<any>(
        `feed-config:${address.toBase58()}`,
        30_000,
        () => (oracle.account as any).feedConfig.fetchNullable(address),
      );
      if (!raw) {
        setState({ kind: "unconfigured" });
        return;
      }

      config = {
        address,
        admin: raw.admin,
        feedId: Uint8Array.from(raw.feedId),
        source: raw.source,
        maxAgeSecs: Number(raw.maxAgeSecs),
        minVerificationSignatures: Number(raw.minVerificationSignatures),
      };

      // The quote itself moves, so this window is short — just long enough to
      // collapse the burst of identical reads that happens on mount.
      const sourceInfo = await shared(
        `price:${config.source.toBase58()}`,
        5_000,
        () => conn.getAccountInfo(config!.source),
      );
      if (!sourceInfo) {
        setState({
          kind: "error",
          message: "the configured price account does not exist",
          config,
        });
        return;
      }

      const update = decodePriceUpdateV2(Uint8Array.from(sourceInfo.data));

      // The program checks the quote's own feed id against the config, so a
      // rotated source cannot change what a series settles against. Same check
      // here, for the same reason.
      if (!config.feedId.every((b, i) => b === update.feedId[i])) {
        setState({
          kind: "error",
          message: "price account reports a different feed",
          config,
        });
        return;
      }

      const [price, decimals] = scaleFromExpo(update.price, update.exponent);
      const [confidence] = scaleFromExpo(update.conf, update.exponent);
      const publishTime = Number(update.publishTime);
      const ageSecs = Math.floor(Date.now() / 1000) - publishTime;

      setState({
        kind: "ready",
        config,
        quote: {
          feedId: update.feedId,
          price,
          confidence,
          decimals,
          publishTime,
          ageSecs,
          stale: ageSecs > config.maxAgeSecs,
          verification: update.verificationLevel.full
            ? { kind: "full" }
            : { kind: "partial", signatures: Number(update.verificationLevel.partial ?? 0) },
        },
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
        config,
      });
    }
  }, [oracle, feedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // An explicit reload has to bypass the coalescer, or the button does nothing
  // for as long as the cached entry lives.
  const reload = useCallback(() => {
    invalidate("price:");
    invalidate("feed-config:");
    return load();
  }, [load]);

  return { state, reload };
}

// Re-exported so callers have one import site for the oracle path, while the
// implementations stay in the plain-JS module the build-time gate checks.
export { decodePriceUpdateV2, scaleFromExpo, formatQuote };
