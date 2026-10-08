/** A separate build target: never inferred from a Solana network name. */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/** Illustrative fixtures, deliberately independent of current market quotes. */
export const STUB_ASSETS = [
  { symbol: "AAPL", name: "Apple", base: 220, vol: 0.3, phase: 0.3 },
  { symbol: "TSLA", name: "Tesla", base: 250, vol: 0.65, phase: 1.7 },
  { symbol: "NVDA", name: "NVIDIA", base: 140, vol: 0.55, phase: 2.9 },
  { symbol: "MSFT", name: "Microsoft", base: 430, vol: 0.28, phase: 4.1 },
  { symbol: "AMZN", name: "Amazon", base: 200, vol: 0.35, phase: 5.3 },
  { symbol: "GOOGL", name: "Alphabet", base: 180, vol: 0.32, phase: 0.9 },
] as const;
