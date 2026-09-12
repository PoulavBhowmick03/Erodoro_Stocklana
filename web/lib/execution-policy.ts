import type { Capabilities } from "./capabilities";

export const MAGICBLOCK_CREDIT = "(powered by MagicBlock)";

/**
 * One policy for every CLOB implementation. Reading is always allowed, but
 * order mutations never fall back to L1 when the execution session is down.
 *
 * The second half of that rule used to be re-decided here from a `delegated`
 * boolean, in parallel with `trading.write` deciding the same thing from the
 * same fact. Two answers to one question is one answer too many, so this now
 * asks the capability model and only adds what the model has no opinion on:
 * whether anyone is holding the pen.
 */
export function orderMutationBlocker({
  connected,
  capabilities,
}: {
  connected: boolean;
  capabilities: Capabilities;
}): string | undefined {
  if (!connected) return "Connect a wallet or choose a test trader to place an order.";
  const write = capabilities["trading.write"];
  return write.available ? undefined : write.reason;
}

export function assertMagicBlockOrderRoute(delegated: boolean): void {
  if (!delegated) {
    throw new Error(
      `Order not sent: live execution ${MAGICBLOCK_CREDIT} is not ready.`,
    );
  }
}

export function executionStatus(delegated: boolean) {
  return delegated
    ? `Live execution ${MAGICBLOCK_CREDIT}`
    : `Preparing live execution ${MAGICBLOCK_CREDIT}`;
}
