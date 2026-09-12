import type { Metadata } from "next";

import { AppChrome } from "@/components/app-chrome";
import { PortfolioScreen } from "@/components/portfolio-screen";
import { SolanaProvider } from "@/components/solana-provider";

export const metadata: Metadata = {
  title: "Portfolio · erodoro",
  description:
    "Your P and N positions, open orders, and balances held in live execution.",
};

export default function PortfolioPage() {
  return (
    <SolanaProvider>
      <AppChrome
        title="Portfolio"
        lede="Your P and N positions, open orders, and balances held in live execution."
      >
        <PortfolioScreen />
      </AppChrome>
    </SolanaProvider>
  );
}
