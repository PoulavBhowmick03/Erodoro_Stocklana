import { BN } from "@coral-xyz/anchor";

/** Raw integer -> human decimal string, without going through a float. */
export function fromRaw(raw: BN | bigint | number, decimals: number, dp = 4) {
  const v = new BN(raw.toString());
  const base = new BN(10).pow(new BN(decimals));
  const whole = v.div(base).toString();
  const frac = v.mod(base).toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** A price stored with `price_decimals`, rendered as dollars. */
export function priceToUsd(price: BN | string | number, decimals: number) {
  const n = Number(fromRaw(new BN(price.toString()), decimals, 2));
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortKey(k: { toBase58(): string } | string, n = 4) {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

export function timeUntil(unixTs: number) {
  const secs = unixTs - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "matured";
  const d = Math.floor(secs / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

export function formatDate(unixTs: number) {
  return new Date(unixTs * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** `SeriesStatus` comes back from Anchor as `{ open: {} }` and friends. */
export function statusOf(status: Record<string, unknown>): "Open" | "Paused" | "Settled" {
  const k = Object.keys(status)[0] ?? "open";
  return (k.charAt(0).toUpperCase() + k.slice(1)) as "Open" | "Paused" | "Settled";
}

/**
 * Human decimal string -> raw integer string, without touching a float.
 *
 * `Number` would silently lose precision on large 8-decimal amounts, and this
 * value becomes a token transfer, so it is parsed as text and padded.
 */
export function toRaw(value: string, decimals: number): string {
  const [whole = "0", frac = ""] = value.trim().split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}
