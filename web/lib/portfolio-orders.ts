/** Iterate both book sides once while retaining their economic meaning. */
export function* ordersBySide<T>(
  bids: Iterable<T>,
  asks: Iterable<T>,
): Generator<{ order: T; side: "buy" | "sell" }> {
  for (const order of bids) yield { order, side: "buy" };
  for (const order of asks) yield { order, side: "sell" };
}
