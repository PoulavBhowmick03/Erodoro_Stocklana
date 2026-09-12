"use client";

import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import { useTestWallet } from "@/components/test-wallet";

import factoryIdl from "./idl/factory.json";
import seriesIdl from "./idl/series.json";
import oracleIdl from "./idl/oracle_adapter.json";
import marketIdl from "./idl/market.json";
import {
  FACTORY_PROGRAM,
  MARKET_PROGRAM,
  ORACLE_ADAPTER_PROGRAM,
  SERIES_PROGRAM,
  idlAt,
} from "./program-addresses";

/**
 * Anchor clients for the deployed programs.
 *
 * The IDLs are copied from `target/idl` at build time and carry their own
 * program addresses, so there is no address list to keep in sync here — run
 * `make idl` and copy them again after any interface change.
 */
export function usePrograms() {
  const { connection } = useConnection();
  const real = useAnchorWallet();
  const { keypair } = useTestWallet();

  // A test keypair outranks a connected wallet. It only exists on devnet, and
  // if one is selected the whole point is that it signs -- a provider that
  // quietly kept using the extension would make the toggle a lie.
  const wallet = useMemo(
    () =>
      keypair
        ? {
            publicKey: keypair.publicKey,
            signTransaction: async (tx: any) => {
              tx.partialSign(keypair);
              return tx;
            },
            signAllTransactions: async (txs: any[]) => {
              txs.forEach((tx) => tx.partialSign(keypair));
              return txs;
            },
          }
        : real,
    [keypair, real],
  );

  return useMemo(() => {
    // A read-only provider still needs *a* wallet shape. Anchor only touches
    // it when signing, so browsing works fine before anyone connects.
    const provider = new AnchorProvider(
      connection,
      wallet ?? ({} as never),
      AnchorProvider.defaultOptions(),
    );

    return {
      provider,
      connected: Boolean(wallet),
      factory: new Program(idlAt(factoryIdl, FACTORY_PROGRAM) as Idl, provider),
      series: new Program(idlAt(seriesIdl, SERIES_PROGRAM) as Idl, provider),
      oracle: new Program(idlAt(oracleIdl, ORACLE_ADAPTER_PROGRAM) as Idl, provider),
      market: new Program(idlAt(marketIdl, MARKET_PROGRAM) as Idl, provider),
    };
  }, [connection, wallet]);
}
