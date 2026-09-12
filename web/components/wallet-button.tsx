"use client";

import dynamic from "next/dynamic";

/**
 * The wallet button reads `window` during render, so it must never be part of
 * the server-rendered HTML — hydration would mismatch the moment a wallet
 * extension is present. `ssr: false` is the whole point of this file.
 */
export const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  {
    ssr: false,
    loading: () => (
      <div className="bg-panel border-line h-10 w-[8.5rem] animate-pulse rounded-sm border" />
    ),
  },
);
