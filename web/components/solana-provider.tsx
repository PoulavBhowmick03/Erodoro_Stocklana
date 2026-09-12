"use client";

import { useEffect, useMemo } from "react";
import { TestWalletProvider } from "./test-wallet";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import type { ConnectionConfig } from "@solana/web3.js";
import { isWalletConnectionFailure, isWalletRejection } from "@/lib/wallet-errors";
import {
  NETWORK,
  RPC_FALLBACK_URL,
  RPC_URL,
  USES_PUBLIC_RPC_FALLBACK,
} from "@/lib/network-config";
import { createRpcFallbackFetch } from "@/lib/rpc-fallback";
import { NetworkBoundary } from "./network-boundary";
import { installBufferCompat } from "@/lib/buffer-compat";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * At module scope, not in an effect: the SDKs encode u64 values while building
 * instructions, which happens before any component of ours has rendered. This
 * provider is the outermost thing that touches chain code, so importing it is
 * what guarantees the accessors exist first.
 */
installBufferCompat();

function handleWalletError(error: WalletError, adapter?: Adapter) {
  // WalletProvider logs every adapter error by default. Next's development
  // overlay then turns a perfectly ordinary Reject click into a full-screen
  // "Console WalletSendTransactionError". useSend owns the user-facing status;
  // only unexpected wallet failures belong in the console.
  if (!isWalletRejection(error) && !isWalletConnectionFailure(error)) {
    console.error(error, adapter);
  }
}

/**
 * Wallet Standard remembers the previously selected wallet. Connections are
 * user-initiated, but a broken extension can still leave the header saying
 * "Connecting" forever after a click. Clearing the selection returns to an
 * ordinary, readable disconnected market after the bounded deadline.
 */
function WalletReconnectGuard({ children }: { children: React.ReactNode }) {
  const { connecting, connected, select } = useWallet();

  useEffect(() => {
    if (!connecting || connected) return;
    const timeout = window.setTimeout(() => select(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [connected, connecting, select]);

  return children;
}

/**
 * Wallet plumbing. Client-only by necessity — it touches `window` and browser
 * wallet extensions, so it cannot render on the server.
 *
 * No wallet list is passed to `WalletProvider`. Every current wallet
 * implements the Wallet Standard and registers itself, so an explicit list
 * only serves to exclude wallets that would otherwise work.
 */
export function SolanaProvider({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => RPC_URL, []);
  const connectionConfig = useMemo<ConnectionConfig>(() => {
    if (!RPC_FALLBACK_URL) return { commitment: "confirmed" };
    return {
      commitment: "confirmed",
      fetch: createRpcFallbackFetch({ fallbackUrl: RPC_FALLBACK_URL }),
      // The fallback fetch owns 429 handling. Letting web3.js retry as well
      // would hit the public endpoint repeatedly before failing over.
      disableRetryOnRateLimit: true,
    };
  }, []);

  // The public endpoint is fine for a demo and cannot serve an audience. It
  // rate-limits hard, and the first thing a user sees when it does is a page
  // that looks broken. Falling back to it silently in a production build is the
  // kind of default that only reveals itself under load, so it says so.
  return (
    <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
      {USES_PUBLIC_RPC_FALLBACK && process.env.NODE_ENV === "production" && (
        <div className="border-n/30 bg-n/5 border-b px-4 py-2 text-center">
          <p className="text-n text-[0.82rem]">
            This build is talking to the public {NETWORK.label} endpoint. It
            rate-limits, and it cannot serve real traffic.
          </p>
        </div>
      )}
      <NetworkBoundary>
        <TestWalletProvider>
          <WalletProvider wallets={[]} autoConnect={false} onError={handleWalletError}>
            <WalletReconnectGuard>
              <WalletModalProvider>{children}</WalletModalProvider>
            </WalletReconnectGuard>
          </WalletProvider>
        </TestWalletProvider>
      </NetworkBoundary>
    </ConnectionProvider>
  );
}
