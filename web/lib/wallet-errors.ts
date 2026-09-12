/**
 * Wallets wrap provider errors differently, sometimes several layers deep.
 * A rejected signature is a deliberate user cancellation, not an application
 * failure, so inspect both the wrapper and its causes before deciding how to
 * present it.
 */
export function isWalletRejection(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const text =
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : typeof current === "string"
          ? current
          : String(current);

    if (/user rejected|rejected (?:the )?request|request rejected|declined/i.test(text)) {
      return true;
    }

    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }

  return false;
}

/**
 * Browser wallets can advertise through Wallet Standard even when their
 * extension bridge cannot finish connecting. That is a recoverable wallet
 * choice, not an application-rendering failure, so it must not be sent through
 * Next's console-error overlay.
 */
export function isWalletConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const text = current instanceof Error
      ? `${current.name}: ${current.message}`
      : typeof current === "string"
        ? current
        : String(current);

    if (
      /WalletConnectionError|WalletNotReadyError|failed to connect to (?:MetaMask|wallet)|extension not found/i.test(text)
    ) {
      return true;
    }

    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }

  return false;
}
