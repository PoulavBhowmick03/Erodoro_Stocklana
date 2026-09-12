export type BookSide = "bid" | "ask";

export type BookEntry<T> = {
  price: number;
  size: number;
  order: T;
};

export type BookLevel<T> = {
  price: number;
  size: number;
  /** Size available from the best price through this level. */
  total: number;
  orders: T[];
};

/**
 * Collapse price-time orders into the price levels shown by a classic L2 book.
 *
 * Levels are returned best-first on both sides. The UI reverses asks so the
 * best ask sits directly above the spread while bids naturally start below it.
 * Order submission continues to use Manifest's own atomic-unit conversion;
 * these token numbers are display-only book values from the SDK.
 */
export function aggregateBookSide<T>(
  entries: readonly BookEntry<T>[],
  side: BookSide,
): BookLevel<T>[] {
  const grouped = new Map<number, { size: number; orders: T[] }>();

  for (const entry of entries) {
    if (
      !Number.isFinite(entry.price) ||
      !Number.isFinite(entry.size) ||
      entry.price <= 0 ||
      entry.size <= 0
    ) {
      continue;
    }
    const level = grouped.get(entry.price);
    if (level) {
      level.size += entry.size;
      level.orders.push(entry.order);
    } else {
      grouped.set(entry.price, { size: entry.size, orders: [entry.order] });
    }
  }

  const levels = [...grouped.entries()]
    .map(([price, level]) => ({ price, ...level, total: 0 }))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));

  let cumulative = 0;
  for (const level of levels) {
    cumulative += level.size;
    level.total = cumulative;
  }
  return levels;
}

export function bookSpread(bestAsk?: number, bestBid?: number) {
  if (bestAsk === undefined || bestBid === undefined) return null;
  return bestAsk - bestBid;
}
