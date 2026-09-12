import type { BlockhashWithExpiryBlockHeight } from "@solana/web3.js";

export type TransactionTarget = "solana" | "magicblock";
export type SendPhase = "preparing" | "approval" | "submitted" | "confirming";

/**
 * Confirmation must use the exact lifetime that was signed into the
 * transaction. Using a newly fetched blockhash can report a landed signature
 * as expired (or wait on a lifetime the transaction never had).
 */
export function confirmationStrategy(
  signature: string,
  lifetime: BlockhashWithExpiryBlockHeight,
) {
  return {
    signature,
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}

export function isTransactionExpired(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    /TransactionExpired|BlockheightExceeded/i.test(name) ||
    /block height exceeded|blockhash.*(expired|not found)|transaction expired/i.test(
      message,
    )
  );
}

/** A stable, user-facing description for every asynchronous send phase. */
export function sendPhaseLabel(phase: SendPhase, target: TransactionTarget) {
  if (phase === "preparing") return "Checking the transaction…";
  if (phase === "approval") return "Approve in your wallet…";
  if (phase === "confirming") {
    return target === "magicblock" ? "Confirming on MagicBlock…" : "Confirming on Solana…";
  }
  return target === "magicblock"
    ? "Submitted to MagicBlock…"
    : "Submitted to Solana…";
}
