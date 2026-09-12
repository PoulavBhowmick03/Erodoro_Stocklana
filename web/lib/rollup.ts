"use client";

import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { Connection, type PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";

import marketIdl from "./idl/market.json";
import { MAGICBLOCK_DELEGATION_PROGRAM_ID } from "./manifest";
import { MARKET_PROGRAM, idlAt } from "./program-addresses";
import { EPHEMERAL_RPC_URL } from "./network-config";

/**
 * The ephemeral rollup endpoint.
 *
 * A delegated book lives on two chains at once: L1 still holds the account, but
 * the delegation program owns it there and every write bounces. The readable,
 * writable copy is on the rollup, at a different URL. `tests/rollup-session.ts`
 * puts it plainly — "identical instructions; only the endpoint differs" — and
 * this is the endpoint the app was missing.
 */
export { EPHEMERAL_RPC_URL };

/**
 * An Anchor client for `market`, pointed at the rollup instead of L1.
 *
 * Deliberately a separate client rather than a flag on the existing one. The
 * two connections confirm against different ledgers, and a single client that
 * silently switched endpoints would make "which chain did that land on?"
 * unanswerable at exactly the moment it matters.
 */
export function useEphemeral() {
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!EPHEMERAL_RPC_URL) {
      throw new Error("This Mainnet build has no configured MagicBlock RPC.");
    }
    const connection = new Connection(EPHEMERAL_RPC_URL, "confirmed");
    const provider = new AnchorProvider(
      connection,
      wallet ?? ({} as never),
      AnchorProvider.defaultOptions(),
    );
    return {
      connection,
      market: new Program(idlAt(marketIdl, MARKET_PROGRAM) as Idl, provider),
    };
  }, [wallet]);
}

export type BookLocation =
  /** Owned by `market` on L1. Seats, e-token preparation, and claims work here. */
  | { kind: "l1" }
  /**
   * Delegated. Orders and projected e-token deposits run on the rollup; the
   * market eATAs remain backed by e-token's global vault on L1.
   */
  | { kind: "rollup"; owner: PublicKey }
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | { kind: "loading" };

/**
 * Where a book currently lives.
 *
 * Determined by who owns the account on L1: while a session is open the
 * delegation program does, not `market`. That single fact decides which
 * connection every subsequent read and write should use.
 */
export function useBookLocation(book: PublicKey | null, marketProgramId: PublicKey) {
  const { connection } = useConnection();
  const [location, setLocation] = useState<BookLocation>({ kind: "loading" });

  const check = useCallback(async () => {
    if (!book) return setLocation({ kind: "absent" });
    try {
      const info = await connection.getAccountInfo(book);
      if (!info) return setLocation({ kind: "absent" });
      if (info.owner.equals(marketProgramId)) {
        setLocation({ kind: "l1" });
      } else if (info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID)) {
        setLocation({ kind: "rollup", owner: info.owner });
      } else {
        setLocation({
          kind: "error",
          message: `Market account has unexpected owner ${info.owner.toBase58()}.`,
        });
      }
    } catch (error) {
      setLocation({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [book, connection, marketProgramId]);

  useEffect(() => {
    void check();
    // A session can open or close without this tab doing anything, and the
    // difference decides whether deposits work. Poll rather than strand the
    // user on a stale view.
    const id = setInterval(() => void check(), 10_000);
    return () => clearInterval(id);
  }, [check]);

  return { location, recheck: check };
}
