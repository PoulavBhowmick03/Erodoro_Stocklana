import type { Connection, PublicKey, AccountInfo } from "@solana/web3.js";

/** `getMultipleAccounts` takes at most 100 keys per call. */
export const MAX_KEYS_PER_CALL = 100;

/**
 * Fetch many accounts in as few round trips as the RPC allows.
 *
 * The naive shape -- one `fetch` per account -- is `1 + 2N` requests to list N
 * series, which is fine for the three on devnet and is a denial of service
 * against your own RPC provider at a few hundred. This is `ceil(N / 100)`
 * instead.
 *
 * Missing accounts come back as `null` in place rather than throwing, because
 * "this series has not settled" and "this address is wrong" arrive through the
 * same hole and only one of them is an error.
 */
export async function getMultipleAccountsBatched(
  connection: Connection,
  keys: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  if (keys.length === 0) return [];

  const chunks: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
    chunks.push(keys.slice(i, i + MAX_KEYS_PER_CALL));
  }

  // Sequential rather than parallel: a burst of concurrent
  // `getMultipleAccounts` is exactly what public endpoints rate-limit, and the
  // chunks are large enough that the round-trip count is already small.
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (const chunk of chunks) {
    const infos = await withRetry(() => connection.getMultipleAccountsInfo(chunk));
    out.push(...infos);
  }
  return out;
}

/**
 * Retry a request that failed for a reason that might not recur.
 *
 * Public RPC endpoints answer with 429 and 5xx under load, and a page that
 * gives up on the first one shows an error to a user whose only problem was
 * arriving at a busy moment. Backoff is exponential with jitter so a thousand
 * clients that all failed together do not all retry together.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i === attempts - 1 || !isRetryable(e)) break;
      const backoff = 250 * 2 ** i;
      const jitter = Math.random() * backoff;
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
  throw lastError;
}

/**
 * Whether a failure is worth trying again.
 *
 * Rate limits and gateway errors are transient. A malformed request or a
 * rejected transaction is not, and retrying it just makes the user wait longer
 * for the same answer.
 */
function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /\b429\b/.test(msg) ||
    /\b50[0-4]\b/.test(msg) ||
    /rate.?limit/i.test(msg) ||
    /too many requests/i.test(msg) ||
    /timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(msg)
  );
}
