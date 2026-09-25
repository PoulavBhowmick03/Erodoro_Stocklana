import { AppChrome } from "@/components/app-chrome";
import { SolanaProvider } from "@/components/solana-provider";
export const metadata = { title: "Market Rip · erodoro" };
export default function MarketRipPage() {
  return (
    <SolanaProvider>
      <AppChrome active="/market-rip" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        <section>
          <p className="kicker">MARKET RIP</p>
          <h1 className="font-display mt-3 text-5xl tracking-tight">
            Pull one live stock move
          </h1>
          <p className="text-muted mt-4 text-lg">
            Explore the $1 stock-move experience.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            <span className="text-muted text-sm">
              Market Rip is not available on Solana.
            </span>
          </div>
          <button
            type="button"
            disabled
            aria-describedby="rip-unavailable"
            className="bg-accent text-ink mt-8 px-8 py-4 font-mono text-base disabled:opacity-50"
          >
            RIP $1
          </button>
          <p id="rip-unavailable" className="text-muted mt-3 text-sm">
            There is no funded Rip pool on this network. No purchase can be
            submitted.
          </p>
        </section>
        <section className="border-line mt-14 border-t pt-8">
          <h2 className="font-display text-3xl">My Rips</h2>
          <p className="text-muted mt-4">
            Rip positions are unavailable on this network.
          </p>
        </section>
        <details className="border-line mt-10 border-t pt-5 text-sm">
          <summary className="cursor-pointer font-mono">Pool state</summary>
          <p className="text-muted mt-3">Not deployed · No funded inventory</p>
        </details>
      </main>
    </SolanaProvider>
  );
}
