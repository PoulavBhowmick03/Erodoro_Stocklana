"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  getScaledUiAmountConfig,
  unpackMint,
} from "@solana/spl-token";
import { useConnection } from "@solana/wallet-adapter-react";

import { fromRaw } from "./format";
import { useSigner } from "./use-signer";

export type Holding = {
  mint: string;
  account: string;
  /** Raw on-chain integer, before decimals or any multiplier. */
  raw: bigint;
  decimals: number;
  /**
   * The live `scaledUiAmount` multiplier, or 1 for a mint without one.
   *
   * Computed here rather than taken from the RPC's `uiAmount`, which does not
   * consistently apply it. A balance that silently ignored a 2-for-1 split
   * would be wrong by exactly the factor this protocol exists to handle.
   */
  multiplier: number;
  extensions: string[];
  /**
   * Which token program owns the mint.
   *
   * Not cosmetic. Collateral must be Token-2022 and the book's quote mint must
   * be classic SPL, so a list that blurred the two would happily offer a mint
   * that fails a constraint several screens later.
   */
  program: "token-2022" | "spl";
};

/**
 * The mint created most recently in this tab.
 *
 * Written to sessionStorage by the mint screen and read by the create screen.
 * Keeping it tab-scoped prevents an old mint from a previous visit silently
 * reappearing as today's collateral.
 */
export const LAST_MINT_KEY = "erodoro.lastMint";

/**
 * The classic-SPL mint the books quote against, remembered from the mint
 * screen so opening a market does not ask for an address the app just made.
 */
export const QUOTE_MINT_KEY = "erodoro.quoteMint";

/** The contract most recently listed by this tab, used for the final setup handoff. */
export const LAST_SERIES_KEY = "erodoro.lastSeries";

export type BalancesState =
  | { kind: "loading" }
  | { kind: "ready"; holdings: Holding[] }
  | { kind: "error"; message: string };

const EXT_NAMES: Partial<Record<ExtensionType, string>> = {
  [ExtensionType.ScaledUiAmountConfig]: "scaledUiAmount",
  [ExtensionType.PermanentDelegate]: "permanentDelegate",
  [ExtensionType.TransferHook]: "transferHook",
  [ExtensionType.PausableConfig]: "pausable",
  [ExtensionType.DefaultAccountState]: "defaultAccountState",
  [ExtensionType.TransferFeeConfig]: "transferFee",
};

/**
 * Every Token-2022 balance the current signer holds.
 *
 * Scoped to Token-2022 on purpose: this is the collateral side of the app, and
 * a list padded with plain SPL dust would bury the one mint the user actually
 * came here to find.
 *
 * The mint accounts are fetched in a second batched call rather than one call
 * per holding, because the extensions are read off the mint and a test key can
 * easily accumulate a dozen of these over a session.
 */
export function useTokenBalances(refreshKey = 0) {
  const { connection } = useConnection();
  const owner = useSigner();
  const [state, setState] = useState<BalancesState>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!owner) return setState({ kind: "ready", holdings: [] });
    try {
      // Both token programs. The app mints into each of them on purpose, and a
      // list that showed only one would hide half of what the user is holding.
      const [t22, spl] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      ]);

      const rows = [
        ...t22.value.map((v) => ({ v, program: "token-2022" as const })),
        ...spl.value.map((v) => ({ v, program: "spl" as const })),
      ].map(({ v: { pubkey, account }, program }) => {
        const info = (account.data as any).parsed.info;
        return {
          account: pubkey.toBase58(),
          mint: info.mint as string,
          raw: BigInt(info.tokenAmount.amount as string),
          decimals: info.tokenAmount.decimals as number,
          program,
        };
      });

      // Only Token-2022 mints carry extensions, so only they need unpacking.
      const mints = [...new Set(rows.filter((r) => r.program === "token-2022").map((r) => r.mint))];
      const infos = mints.length
        ? await connection.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)))
        : [];

      const meta = new Map<string, { multiplier: number; extensions: string[] }>();
      mints.forEach((m, i) => {
        const info = infos[i];
        if (!info) return;
        try {
          const mint = unpackMint(new PublicKey(m), info, TOKEN_2022_PROGRAM_ID);
          const types = getExtensionTypes(mint.tlvData);
          const scaled = getScaledUiAmountConfig(mint);
          // A scheduled multiplier is the live one only once its timestamp has
          // passed, which is exactly how the program reads it at settlement.
          const now = Math.floor(Date.now() / 1000);
          const multiplier = scaled
            ? Number(scaled.newMultiplierEffectiveTimestamp) <= now
              ? scaled.newMultiplier
              : scaled.multiplier
            : 1;
          meta.set(m, {
            multiplier: Number(multiplier) || 1,
            extensions: types.map((t) => EXT_NAMES[t] ?? ExtensionType[t] ?? String(t)),
          });
        } catch {
          // An unparseable mint is still a real balance; show it plainly
          // rather than dropping the row.
        }
      });

      const holdings: Holding[] = rows
        .map((r) => ({
          ...r,
          multiplier: meta.get(r.mint)?.multiplier ?? 1,
          extensions: meta.get(r.mint)?.extensions ?? [],
        }))
        .sort((a, b) => (a.raw === b.raw ? 0 : a.raw > b.raw ? -1 : 1));

      setState({ kind: "ready", holdings });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, [connection, owner]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { state, reload: load };
}

/**
 * Raw integer, decimals and multiplier folded into one display string.
 *
 * The common case goes through `fromRaw`, which never touches a float. Only a
 * multiplier other than 1 forces one, and that is unavoidable: the multiplier
 * itself is an f64 on chain.
 */
export function displayAmount(h: Holding): string {
  const exact = fromRaw(h.raw, h.decimals, 4);
  if (h.multiplier === 1) return exact;
  return (Number(exact) * h.multiplier).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}
