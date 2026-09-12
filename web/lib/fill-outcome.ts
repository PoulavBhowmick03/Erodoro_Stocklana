/**
 * What actually happened to an order, once the chain has been read back.
 *
 * "Confirmed" is not an outcome a trader can act on. A limit order that crossed
 * the book is already a position; one that did not is money committed to a
 * resting quote that may never fill. Those need different next steps, and the
 * app said the same thing for both.
 *
 * Determined by difference, not by assumption: the resting orders belonging to
 * the signer are counted before and after, so pre-existing orders on the same
 * market cannot be mistaken for this one.
 */
export type FillOutcome =
  | { kind: "rested"; requested: number }
  | { kind: "partial"; requested: number; filled: number; resting: number }
  | { kind: "filled"; requested: number };

export function describeFill({
  requested,
  restingAfter,
}: {
  /** Base tokens the order asked for. */
  requested: number;
  /** Base tokens still resting that belong to this order. */
  restingAfter: number;
}): FillOutcome {
  // Floating point: a fill is only "complete" within the precision the book
  // itself reports, and an exact-zero comparison would call a dust remainder a
  // partial fill forever.
  const epsilon = Math.max(requested, 1) * 1e-9;
  const resting = Math.max(0, Math.min(requested, restingAfter));
  const filled = requested - resting;

  if (filled <= epsilon) return { kind: "rested", requested };
  if (resting <= epsilon) return { kind: "filled", requested };
  return { kind: "partial", requested, filled, resting };
}

const amount = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 6 });

/** One sentence, in the terms the trader used. */
export function fillMessage(outcome: FillOutcome, symbol: string, side: "buy" | "sell"): string {
  const verb = side === "buy" ? "bought" : "sold";
  switch (outcome.kind) {
    case "filled":
      return `Filled immediately. You ${verb} ${amount(outcome.requested)} ${symbol}.`;
    case "partial":
      return `Partly filled: ${amount(outcome.filled)} ${symbol} ${verb}, ${amount(outcome.resting)} ${symbol} still resting on the book.`;
    default:
      return `Resting on the book: ${amount(outcome.requested)} ${symbol}. Nothing has traded yet.`;
  }
}

/** Where the result of this order now lives, so the trader knows where to look. */
export function fillDestination(outcome: FillOutcome): string {
  switch (outcome.kind) {
    case "filled":
      return "It is in your portfolio.";
    case "partial":
      return "The filled part is in your portfolio; the rest is under open orders.";
    default:
      return "It is under open orders until it fills or you cancel it.";
  }
}
