import { AppChrome } from "@/components/app-chrome";
import { SolanaProvider } from "@/components/solana-provider";
import { MintScreen } from "@/components/mint-screen";
import { IS_DEVNET } from "@/lib/network-config";
export const metadata = { title: "Get test assets · erodoro" };
export default function FaucetPage() {
  return (
    <SolanaProvider>
      <AppChrome active="/faucet" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">
          Get test assets
        </h1>
        <p className="text-muted mt-3 max-w-[58ch]">
          Create test stock and test cash, then run the whole flow end to end.
        </p>
        <div className="mt-8">
          {IS_DEVNET ? (
            <MintScreen />
          ) : (
            <p className="text-muted">
              Test assets are available only on Solana devnet.
            </p>
          )}
        </div>
      </main>
    </SolanaProvider>
  );
}
