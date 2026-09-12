"use client";

import { useEffect } from "react";

/**
 * The last line before a blank page.
 *
 * Without this, an unhandled render error takes the whole route down to white.
 * Most of what can throw here is an RPC call -- a rate limit, an endpoint
 * having a bad minute, a malformed account -- and none of that is worth losing
 * the page over. `useSeries` catches its own failures and shows them in place;
 * this catches everything that did not think to.
 *
 * `reset` re-renders the segment, which re-runs the fetches.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Nothing is wired to an error reporter yet, so the console is the only
    // place this exists. Worth saying out loud rather than leaving an empty
    // effect that looks like it reports somewhere.
    console.error("unhandled error in the app route:", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <div className="border-line bg-panel rounded-md border p-8 shadow-[0_24px_70px_rgb(10_17_24/0.06)]">
        <div className="text-danger font-mono text-[0.8125rem] tracking-[0.12em] uppercase">Interface error</div>
        <h1 className="mt-3 text-3xl font-medium tracking-[-0.04em]">Something broke on this page</h1>
        <p className="text-muted mt-3 text-[0.92rem]">
          Your funds are not affected — this is the interface failing to draw, not
          anything on chain. Try the page again or inspect the technical detail below.
        </p>

        {error.digest && (
          <p className="text-dim mt-3 font-mono text-[0.78rem]">digest {error.digest}</p>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            onClick={reset}
            className="bg-text hover:bg-accent text-bg rounded-sm px-4 py-2 text-[0.88rem] transition-colors"
          >
            Try again
          </button>
          <a
            href="/app"
            className="border-line hover:border-text rounded-sm border px-4 py-2 text-[0.88rem] transition-colors"
          >
            Back to markets
          </a>
        </div>

        <details className="mt-6">
          <summary className="text-dim cursor-pointer text-[0.82rem]">
            What went wrong
          </summary>
          <pre className="text-dim mt-2 overflow-x-auto text-[0.75rem] whitespace-pre-wrap">
            {error.message}
          </pre>
        </details>
      </div>
    </main>
  );
}
