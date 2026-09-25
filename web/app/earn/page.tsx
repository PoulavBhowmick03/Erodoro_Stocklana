import { Suspense } from "react";
import { AppChrome } from "@/components/app-chrome";
import { SolanaProvider } from "@/components/solana-provider";
import { EarnScreen } from "@/components/earn-screen";
export const metadata = {
  title: "Earn · erodoro",
  description: "Sell your stock upside for a USDC premium on Solana.",
};
export default function EarnPage() {
  return (
    <SolanaProvider>
      <AppChrome active="/earn" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">
          Earn premium on your stocks
        </h1>
        <p className="text-muted mt-3 max-w-[58ch]">
          Choose your terms. Receive a premium when a buyer takes your upside.
        </p>
        <div className="mt-8">
          <Suspense fallback={<p role="status">Loading listed terms…</p>}>
            <EarnScreen />
          </Suspense>
        </div>
      </main>
    </SolanaProvider>
  );
}
