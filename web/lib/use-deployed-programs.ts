"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { MAGICBLOCK_DELEGATION_PROGRAM_ID, MANIFEST_PROGRAM_ID } from "./manifest";
import { FACTORY_PROGRAM, SERIES_PROGRAM } from "./program-addresses";
import { shared } from "./rpc-cache";

/**
 * Whether the programs this app calls are actually on the connected cluster.
 *
 * The genesis check in `NetworkBoundary` proves *which ledger* is being served.
 * It says nothing about whether anything is deployed on it, and those are
 * different failures with different remedies: a wrong endpoint is the operator's
 * to fix, an undeployed program is the release's. Before this, both surfaced as
 * whatever error the first read happened to throw -- usually "Account does not
 * exist", which reads as a missing market rather than a missing protocol.
 *
 * All four are required together. A cluster with `series` but no Manifest can
 * mint claims that cannot be traded, which is not a state worth rendering a
 * trading interface for.
 */
const REQUIRED = [
  SERIES_PROGRAM,
  FACTORY_PROGRAM,
  MANIFEST_PROGRAM_ID,
  MAGICBLOCK_DELEGATION_PROGRAM_ID,
];

/** Null until the check resolves: unknown is not the same as absent. */
export function useDeployedPrograms(): boolean | null {
  const { connection } = useConnection();
  const [deployed, setDeployed] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;

    // One multi-account read rather than four, keyed by endpoint so switching
    // clusters re-checks rather than reusing the previous cluster's answer.
    // Programs are redeployed on the order of weeks, so this is cached for
    // minutes: long enough that mounting several panels costs one request.
    void shared(
      `programs:${connection.rpcEndpoint}`,
      300_000,
      async () => {
        const infos = await connection.getMultipleAccountsInfo(REQUIRED);
        return infos.every((info) => info?.executable === true);
      },
    )
      .then((result) => {
        if (live) setDeployed(result);
      })
      .catch(() => {
        // A failed read is not evidence of absence. Leaving this unknown keeps
        // the capability withheld with "not verified yet" rather than asserting
        // the protocol is missing because one RPC call timed out.
        if (live) setDeployed(null);
      });

    return () => {
      live = false;
    };
  }, [connection]);

  return deployed;
}
