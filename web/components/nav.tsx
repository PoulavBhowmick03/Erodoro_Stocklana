import Link from "next/link";
import { DEMO_MODE } from "@/lib/demo-config";

export function Nav() {
  return (
    <header
      data-landing-header
      className="border-line/80 bg-bg/88 sticky top-0 z-50 border-b backdrop-blur-md"
    >
      {DEMO_MODE && <p className="border-line border-b px-4 py-2 text-center text-sm">Demo mode · simulated assets, prices and funds · no transactions on chain</p>}
      <nav
        className="mx-auto flex min-h-[4.5rem] max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:flex-nowrap sm:px-6"
        aria-label="Landing"
      >
        <div className="flex items-center gap-3 sm:gap-5">
          <Link
            href="/"
            data-landing-wordmark
            className="editorial-wordmark text-[1.35rem] tracking-[0.08em] uppercase transition-opacity hover:opacity-65"
          >
            erodoro
          </Link>
          <span className="text-muted inline-flex items-center gap-1.5 whitespace-nowrap text-[0.625rem] font-medium sm:text-[0.6875rem]">
            <span aria-hidden className="h-2 w-2 bg-accent" />
            Built on Solana
          </span>
        </div>
      </nav>
    </header>
  );
}
