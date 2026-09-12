export type ClaimLeg = "P" | "N";
export type TradeSide = "buy" | "sell";

export function claimLabel(leg: ClaimLeg) {
  return leg === "P" ? "Capped equity claim" : "Upside claim";
}

export function claimDescription(leg: ClaimLeg) {
  return leg === "P"
    ? "Tracks the collateral up to the strike and keeps the full downside."
    : "Pays only the collateral value above the strike at expiry.";
}

export function orderMaximum({
  side,
  price,
  availableBase,
  availableQuote,
}: {
  side: TradeSide;
  price: number;
  availableBase: number;
  availableQuote: number;
}) {
  if (side === "sell") return Math.max(0, availableBase);
  return Number.isFinite(price) && price > 0
    ? Math.max(0, availableQuote / price)
    : 0;
}

export function sizedPercentage(maximum: number, percentage: number) {
  if (!Number.isFinite(maximum) || maximum <= 0) return 0;
  const bounded = Math.max(0, Math.min(100, percentage));
  return (maximum * bounded) / 100;
}

export function orderPreview({
  side,
  price,
  size,
  availableBase,
  availableQuote,
}: {
  side: TradeSide;
  price: number;
  size: number;
  availableBase: number;
  availableQuote: number;
}) {
  const valid =
    Number.isFinite(price) &&
    Number.isFinite(size) &&
    price > 0 &&
    size > 0;
  const total = valid ? price * size : 0;
  return {
    total,
    remaining:
      side === "buy"
        ? Math.max(0, availableQuote - total)
        : Math.max(0, availableBase - (valid ? size : 0)),
  };
}
