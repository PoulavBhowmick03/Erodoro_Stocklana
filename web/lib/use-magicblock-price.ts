"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { RealtimePriceProfile } from "./market-profile";
import {
  decodeMagicBlockPrice,
  MAGICBLOCK_PRICE_PROGRAM,
  magicBlockPriceAddress,
} from "./magicblock-price";
import { useEphemeral } from "./rollup";

export type MagicBlockPriceState =
  | { kind: "disabled" }
  | { kind: "loading" }
  | { kind: "ready"; price: number; publishTime: number; ageSecs: number; address: string }
  | { kind: "error"; message: string; address: string };

export function useMagicBlockPrice(profile?: RealtimePriceProfile | null) {
  const { connection } = useEphemeral();
  const address = useMemo(
    () => (profile ? magicBlockPriceAddress(profile) : null),
    [profile?.feedId, profile?.provider],
  );
  const [state, setState] = useState<MagicBlockPriceState>(
    profile ? { kind: "loading" } : { kind: "disabled" },
  );

  const load = useCallback(async () => {
    if (!profile || !address) {
      setState({ kind: "disabled" });
      return;
    }
    try {
      const info = await connection.getAccountInfo(address, "confirmed");
      if (!info) throw new Error("Real-time price account is unavailable");
      if (!info.owner.equals(MAGICBLOCK_PRICE_PROGRAM)) {
        throw new Error("Real-time price account has an unexpected owner");
      }
      const quote = decodeMagicBlockPrice(info.data, profile.exponent);
      setState({
        kind: "ready",
        price: quote.price,
        publishTime: quote.publishTime,
        ageSecs: Math.max(0, Math.floor(Date.now() / 1000) - quote.publishTime),
        address: address.toBase58(),
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        address: address.toBase58(),
      });
    }
  }, [address, connection, profile]);

  useEffect(() => {
    void load();
    if (!profile) return;
    const timer = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(timer);
  }, [load, profile]);

  return { state, reload: load };
}
