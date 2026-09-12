"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "erodoro:favourites";

/**
 * Starred series, in `localStorage`.
 *
 * Deliberately local rather than on-chain: a favourite is a browsing
 * preference, not a position, and writing it to a wallet-signed account would
 * cost a transaction to express something the user can already see.
 */
export function useFavourites() {
  const [ids, setIds] = useState<string[]>([]);

  // Read after mount rather than during render: `localStorage` does not exist
  // on the server, and reading it during the first render makes the markup
  // disagree with what Next rendered.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setIds(JSON.parse(raw) as string[]);
    } catch {
      // A corrupt or blocked store is not worth surfacing; start empty.
    }
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Ignore: the star simply will not persist.
      }
      return next;
    });
  }, []);

  const has = useCallback((id: string) => ids.includes(id), [ids]);

  return { ids, toggle, has };
}
