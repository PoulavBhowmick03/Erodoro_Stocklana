import { Suspense } from "react";
import { AppChrome } from "@/components/app-chrome";
import { SolanaProvider } from "@/components/solana-provider";
import { StockSwap } from "@/components/stock-swap";
export const metadata = { title: "Swap · erodoro" };
export default function SwapPage() {
  return (
    <SolanaProvider>
      <AppChrome active="/swap" />
      <Suspense fallback={<p className="p-6">Loading swap…</p>}>
        <StockSwap />
      </Suspense>
    </SolanaProvider>
  );
}
