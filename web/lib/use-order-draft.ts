"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * What the trader had typed, kept across a detour they did not choose.
 *
 * A buyer without enough USDC has to go and get some, and a seller sent to the
 * demo-asset page is in the same position. Both came back to an empty ticket
 * and had to remember their own price and quantity, which is the kind of small
 * loss that makes an app feel careless.
 *
 * Session storage, not local: a draft is a detail of the visit, and a price
 * someone typed last week is not something to resurrect. Keyed by market and
 * leg so two tabs on two markets do not overwrite each other.
 *
 * # What is deliberately not stored
 *
 * No signature, no wallet authority, no balance, no derived affordability.
 * A draft is what the user typed and nothing else — anything else here would be
 * a value the app could later trust without having re-read the chain.
 */
export type OrderDraft = {
  side: "buy" | "sell";
  price: string;
  size: string;
};

const key = (market: string, leg: string) => `erodoro.draft.${market}.${leg}`;

/** Only the three fields above, and only if they look like what we wrote. */
function parse(raw: string | null): OrderDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OrderDraft>;
    if (value.side !== "buy" && value.side !== "sell") return null;
    if (typeof value.price !== "string" || typeof value.size !== "string") return null;
    // Anything that is not a plain decimal did not come from the ticket.
    if (!/^[0-9]*\.?[0-9]*$/.test(value.price)) return null;
    if (!/^[0-9]*\.?[0-9]*$/.test(value.size)) return null;
    return { side: value.side, price: value.price, size: value.size };
  } catch {
    return null;
  }
}

export function useOrderDraft(market: string | null, leg: string) {
  const [restored, setRestored] = useState<OrderDraft | null>(null);

  useEffect(() => {
    if (!market) return;
    try {
      setRestored(parse(window.sessionStorage.getItem(key(market, leg))));
    } catch {
      // Storage can be unavailable. A lost draft is a small cost; a crash here
      // would take the whole market page with it.
      setRestored(null);
    }
  }, [market, leg]);

  const save = useCallback(
    (draft: OrderDraft) => {
      if (!market) return;
      try {
        // An empty ticket is not a draft worth restoring.
        if (!draft.price && !draft.size) {
          window.sessionStorage.removeItem(key(market, leg));
          return;
        }
        window.sessionStorage.setItem(key(market, leg), JSON.stringify(draft));
      } catch {
        // See above.
      }
    },
    [market, leg],
  );

  /** Called once an order is confirmed: the draft has become a real order. */
  const clear = useCallback(() => {
    if (!market) return;
    try {
      window.sessionStorage.removeItem(key(market, leg));
    } catch {
      // See above.
    }
  }, [market, leg]);

  return { restored, save, clear };
}

/** Exported for tests, which should not have to reach into storage keys. */
export const orderDraftInternals = { key, parse };
