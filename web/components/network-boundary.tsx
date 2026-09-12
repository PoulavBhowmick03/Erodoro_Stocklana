"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { ACTIVE_NETWORK, NETWORK, genesisMatches } from "@/lib/network-config";

type NetworkState =
  | { kind: "checking"; mutationsAllowed: false }
  | { kind: "ready"; mutationsAllowed: true; genesisHash: string }
  | { kind: "blocked"; mutationsAllowed: false; message: string; actualGenesis?: string };

const NetworkContext = createContext<NetworkState>({
  kind: "blocked",
  mutationsAllowed: false,
  message: "The Solana network has not been verified.",
});

export const useNetworkState = () => useContext(NetworkContext);

/**
 * Refuse to mount any application or signing state until the configured RPC
 * proves which Solana ledger it serves. This catches a correct-looking build
 * label paired with an endpoint for the other cluster.
 */
export function NetworkBoundary({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const [state, setState] = useState<NetworkState>({
    kind: "checking",
    mutationsAllowed: false,
  });

  useEffect(() => {
    let live = true;
    setState({ kind: "checking", mutationsAllowed: false });
    const timeout = window.setTimeout(() => {
      if (!live) return;
      setState({
        kind: "blocked",
        mutationsAllowed: false,
        message: `The ${NETWORK.label} RPC did not answer the network check in time. No transactions were enabled.`,
      });
    }, 8_000);
    void connection
      .getGenesisHash()
      .then((actualGenesis) => {
        if (!live) return;
        window.clearTimeout(timeout);
        setState(
          genesisMatches(ACTIVE_NETWORK, actualGenesis)
            ? { kind: "ready", mutationsAllowed: true, genesisHash: actualGenesis }
            : {
                kind: "blocked",
                mutationsAllowed: false,
                actualGenesis,
                message: `This ${NETWORK.label} build is connected to a different Solana ledger. Transactions are disabled.`,
              },
        );
      })
      .catch((error) => {
        if (!live) return;
        window.clearTimeout(timeout);
        setState({
          kind: "blocked",
          mutationsAllowed: false,
          message: `Could not verify the ${NETWORK.label} RPC: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
    return () => {
      live = false;
      window.clearTimeout(timeout);
    };
  }, [connection]);

  const value = useMemo(() => state, [state]);

  return (
    <NetworkContext.Provider value={value}>
      {state.kind === "ready" ? children : <NetworkGate state={state} />}
    </NetworkContext.Provider>
  );
}

function NetworkGate({ state }: { state: Exclude<NetworkState, { kind: "ready" }> }) {
  const checking = state.kind === "checking";
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 py-8">
      <div className="border-line flex items-center justify-between border-b pb-5">
        <span className="font-display text-xl font-medium tracking-[-0.05em]">erodoro</span>
        <span className="text-dim font-mono text-[0.8125rem] tracking-[0.1em] uppercase">{NETWORK.label}</span>
      </div>
      <div className="flex flex-1 items-center justify-center py-16">
        <section className="border-line bg-panel w-full max-w-2xl rounded-md border p-7 shadow-[0_24px_70px_rgb(10_17_24/0.06)]">
          <div className="flex items-center gap-3">
            <span className={`size-2 rounded-full ${checking ? "bg-accent animate-pulse" : "bg-danger"}`} />
            <div className="text-accent-ink font-mono text-[0.8125rem] tracking-[0.14em] uppercase">Solana network check</div>
          </div>
          <h1 className="mt-4 text-3xl font-medium tracking-[-0.04em]">
            {checking ? "Verifying the ledger" : "Network configuration mismatch"}
          </h1>
          <p className="text-muted mt-3 max-w-xl text-sm leading-7">
            {checking
              ? "We verify the network before loading balances or enabling transactions. The interface will open automatically when the check completes."
              : state.message}
          </p>
          {!checking && state.actualGenesis && (
            <p className="border-line-soft text-dim mt-5 border-t pt-4 break-all font-mono text-xs">Received genesis: {state.actualGenesis}</p>
          )}
          {!checking && (
            <button onClick={() => window.location.reload()} className="bg-text hover:bg-accent text-bg mt-5 rounded-sm px-4 py-2 text-sm transition-colors">Try again</button>
          )}
        </section>
      </div>
    </main>
  );
}
