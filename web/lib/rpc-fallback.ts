/** HTTP statuses where trying the configured fallback RPC can recover. */
export function isRetryableRpcStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

type RpcFetch = typeof globalThis.fetch;

/**
 * Keep the public Devnet RPC as the local-development default, but fail over
 * to the server-side Helius proxy when that endpoint is rate-limited or
 * temporarily unavailable.
 *
 * After one failure, requests use the fallback for a short cooldown instead
 * of sending every call to an endpoint that has already told us to slow down.
 * A non-retryable JSON-RPC/HTTP error stays on the primary path: changing
 * providers must never turn an invalid request into a different result.
 */
export function createRpcFallbackFetch({
  fallbackUrl,
  fetchImpl = globalThis.fetch,
  cooldownMs = 30_000,
  now = Date.now,
}: {
  fallbackUrl: string;
  fetchImpl?: RpcFetch;
  cooldownMs?: number;
  now?: () => number;
}): RpcFetch {
  let fallbackUntil = 0;

  const fetchFallback = (init?: RequestInit) => fetchImpl(fallbackUrl, init);

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (now() < fallbackUntil) {
      try {
        const fallback = await fetchFallback(init);
        if (fallback.ok || !isRetryableRpcStatus(fallback.status)) return fallback;
      } catch {
        // The public endpoint may have recovered, so try it below.
      }
      fallbackUntil = 0;
    }

    let primary: Response;
    try {
      primary = await fetchImpl(input, init);
    } catch (primaryError) {
      try {
        return await fetchFallback(init);
      } catch {
        throw primaryError;
      }
    }

    if (!isRetryableRpcStatus(primary.status)) return primary;

    try {
      const fallback = await fetchFallback(init);
      if (fallback.ok || !isRetryableRpcStatus(fallback.status)) {
        fallbackUntil = now() + cooldownMs;
        return fallback;
      }
    } catch {
      // Preserve the primary response when both endpoints are unavailable.
    }
    return primary;
  };
}
