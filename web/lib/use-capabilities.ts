"use client";

import { useMemo } from "react";

import { useNetworkState } from "@/components/network-boundary";
import { ACTIVE_NETWORK } from "./network-config";
import { useDeployedPrograms } from "./use-deployed-programs";
import { deriveCapabilities, type Capabilities, type CapabilityEvidence } from "./capabilities";

/**
 * Release facts, which the browser cannot observe for itself.
 *
 * Whether the deployed e-token program exposes the exit interface, whether the
 * deployed trading binaries were reproduced and pinned, and whether a public
 * commit/exit/claim has actually been executed and proved to conserve balances,
 * are things that happened (or did not) outside this application. They are
 * supplied by the deployment rather than guessed, and they default to false: a
 * missing variable must never read as "yes, that was done".
 *
 * They are deliberately three separate facts rather than one "ready" switch.
 * Each is established by different work, by potentially different people, and a
 * single flag would let the easiest of them stand in for the other two.
 */
const flag = (value: string | undefined) => value === "true";

const EXIT_ABI_DEPLOYED = flag(process.env.NEXT_PUBLIC_CUSTODY_EXIT_ABI_DEPLOYED);
const BINARIES_PINNED = flag(process.env.NEXT_PUBLIC_TRADING_BINARIES_PINNED);
const EXIT_PROVEN = flag(process.env.NEXT_PUBLIC_CUSTODY_EXIT_PROVEN);

/**
 * What this deployment can currently do.
 *
 * Assembled from what has actually been read, not from the build target. The
 * cluster comes from the genesis check that already gates the app, the programs
 * from a live account read, and the rest is supplied above.
 *
 * Callers pass what they observed for the market they are looking at, because
 * "is there a live session" is a per-book question and there is no honest
 * global answer to it.
 */
export function useCapabilities(observed?: {
  programsDeployed?: boolean | null;
  sessionActive?: boolean;
  oracleMinSignatures?: number | null;
  exitInterfaceDeployed?: boolean | null;
}): Capabilities {
  const network = useNetworkState();
  const deployed = useDeployedPrograms();
  const overrideDeployed = observed?.programsDeployed;

  return useMemo(() => {
    const evidence: CapabilityEvidence = {
      network: network.kind === "ready" ? ACTIVE_NETWORK : null,
      programsDeployed: overrideDeployed === undefined ? deployed : overrideDeployed,
      sessionActive: observed?.sessionActive ?? false,
      exitInterfaceDeployed: observed?.exitInterfaceDeployed ?? EXIT_ABI_DEPLOYED,
      binariesPinned: BINARIES_PINNED,
      exitProven: EXIT_PROVEN,
      oracleMinSignatures: observed?.oracleMinSignatures ?? null,
    };
    return deriveCapabilities(evidence);
  }, [
    network.kind,
    deployed,
    overrideDeployed,
    observed?.sessionActive,
    observed?.oracleMinSignatures,
    observed?.exitInterfaceDeployed,
  ]);
}
