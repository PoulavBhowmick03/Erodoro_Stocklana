import Link from "next/link";
import { AppChrome } from "@/components/app-chrome";
import { SolanaProvider } from "@/components/solana-provider";
export const metadata = { title: "Live auctions · erodoro" };
export default function AuctionsPage() {
  return (
    <SolanaProvider>
      <AppChrome active="/auctions" />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">
          Live auctions
        </h1>
        <p className="text-muted mt-3 max-w-[64ch]">
          Find opportunities to buy tokenized-stock upside.
        </p>
        <div className="border-line bg-panel mt-8 rounded-md border p-8 text-center">
          <p className="text-base font-medium">
            Auctions are not available on Solana yet.
          </p>
          <p className="text-muted mx-auto mt-2 max-w-md text-sm">
            Use the existing order books to buy or sell upside. Timed bidding
            and automatic auction rounds are not supported on this network.
          </p>
          <Link
            href="/app"
            className="bg-text text-bg hover:bg-accent mt-5 inline-block rounded-sm px-4 py-2.5 text-sm font-medium transition-colors"
          >
            Browse markets →
          </Link>
        </div>
      </main>
    </SolanaProvider>
  );
}
