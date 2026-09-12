"use client";

import { QUOTE_MINT } from "@/lib/deployment";
import { shortKey } from "@/lib/format";
import { Button, Panel } from "./ui";

/** Show the deployment-wide devnet USDC stand-in without minting a browser-local replacement. */
export function QuotePanel({ onCreated }: { onCreated?: () => void }) {
  return (
    <Panel tour="quote-form" title="Demo USDC is ready" subtitle="Every market uses the same valueless devnet quote token.">
      <p className="text-dim font-mono text-xs">
        USDC {shortKey(QUOTE_MINT, 8)}
      </p>
      <div className="mt-4">
        <Button tone="accent" onClick={onCreated}>
          Continue
        </Button>
      </div>
      <p className="text-dim mt-3 text-[0.75rem]">Classic SPL · devnet only · no real value</p>
    </Panel>
  );
}
