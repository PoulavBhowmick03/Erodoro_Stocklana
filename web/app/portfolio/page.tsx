import type { Metadata } from "next";

import { AppChrome } from "@/components/app-chrome";
import { TokenBalances } from "@/components/token-balances";
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
        title="Your portfolio"
        lede="Your positions, premiums, and tokens."
      >
        <div
          data-tour="portfolio-positions"
          className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <PortfolioScreen />
          <TokenBalances title="Wallet tokens" heading="h2" emptyText="No tokens found in this wallet." />
        </div>
      </AppChrome>
    </SolanaProvider>
  );
}
