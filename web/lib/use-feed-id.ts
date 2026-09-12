"use client";

import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { usePrograms } from "./programs";
import { shared } from "./rpc-cache";

/**
 * The feed id behind a series' oracle.
 *
 * `SeriesConfig` stores `oracleAdapter`, which is the *address* of a
 * `FeedConfig` account. `useOracleQuote` wants the 32-byte feed id, and derives
 * the same address back from it. This reads the account once to bridge the two,
 * which is what kept `OraclePanel` off the series page: it had no way to be
 * told which feed to show.
 */
export function useFeedId(feedConfig?: PublicKey) {
  const { oracle } = usePrograms();
  const [feedId, setFeedId] = useState<Uint8Array | undefined>();

  useEffect(() => {
    let live = true;
    if (!feedConfig) {
      setFeedId(undefined);
      return;
    }
    void (async () => {
      // Every row of the markets table asks for this, and they all ask for the
      // same account. One read serves them all.
      const raw = await shared<any>(
        `feed-config:${feedConfig.toBase58()}`,
        30_000,
        () => (oracle.account as any).feedConfig.fetchNullable(feedConfig),
      ).catch(() => null);
      // A missing account is the ordinary case on a cluster where the adapter
      // is not deployed; the panel renders its own empty state for it.
      if (live) setFeedId(raw ? Uint8Array.from(raw.feedId) : undefined);
    })();
    return () => {
      live = false;
    };
  }, [oracle, feedConfig]);

  return feedId;
}
