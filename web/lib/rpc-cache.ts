"use client";

/**
 * Collapses identical concurrent RPC reads into one request.
 *
 * The markets table renders one row per series, and every row independently
 * resolved the same feed config, the same Pyth price account and the same
 * program metadata. Four rows meant roughly twenty calls on mount, all for
 * about five distinct answers, which is what put the public devnet endpoint
 * into rate limiting — and a rate-limited endpoint renders as a table of "—",
 * so this reads as a broken product rather than a busy one.
 *
 * Deliberately tiny: a keyed promise with a short time-to-live. It is a
 * request coalescer, not a state store — nothing here is a source of truth, and
 * a stale entry is only ever a few seconds old.
 */
type Entry = { at: number; value: Promise<unknown> };

const entries = new Map<string, Entry>();

export function shared<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;

  const value = load();
  entries.set(key, { at: Date.now(), value });

  // A rejection must not be served for the rest of the window. One failed read
  // would otherwise pin every later caller to the same error until it expired.
  void value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });

  return value;
}

/** Drop every entry under a prefix, so an explicit reload really reloads. */
export function invalidate(prefix: string) {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}
