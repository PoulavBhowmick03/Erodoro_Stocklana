import type { Metadata } from "next";

import { SolanaProvider } from "@/components/solana-provider";
import { TradeMarketShell } from "@/components/trade-market-shell";

export const metadata: Metadata = {
  title: "Market · erodoro",
  description: "Trade an erodoro P or N market against USDC.",
};

export default function TradeMarketPage() {
  return (
    <SolanaProvider>
      <TradeMarketShell />
    </SolanaProvider>
  );
}
