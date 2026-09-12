import Link from "next/link";

import { WaitlistButton } from "./waitlist-button";

export function Nav() {
  return (
    <header
      data-landing-header
      className="border-line/80 bg-bg/88 sticky top-0 z-50 border-b backdrop-blur-md"
    >
      <nav
        className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
        aria-label="Landing"
      >
        <Link
          href="/"
          data-landing-wordmark
          className="editorial-wordmark text-[1.35rem] tracking-[0.08em] uppercase transition-opacity hover:opacity-65"
        >
          erodoro
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <WaitlistButton />
          <Link
            href="/app"
            className="bg-text hover:bg-accent text-bg rounded-sm px-3 py-2 text-[0.8125rem] font-medium whitespace-nowrap transition-colors sm:px-4"
          >
            Try devnet
          </Link>
        </div>
      </nav>
    </header>
  );
}
