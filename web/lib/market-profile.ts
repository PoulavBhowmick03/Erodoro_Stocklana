import { IS_DEVNET } from "./network-config";

export type RealtimePriceProfile = {
  provider: "pyth-lazer";
  feedId: string;
  exponent: number;
};

export type MarketProfile = {
  symbol: string;
  name: string;
  settlementFeedIdHex: string;
  settlementSource: string;
  settlementExponent: number;
  realtime: RealtimePriceProfile;
};

/**
 * The devnet collateral is valueless, but its payoff is explicitly linked to
 * SOL. Calling it a stock while settling against SOL/USD made the demo terms
 * internally inconsistent even though the oracle bytes were real.
 */
export const DEVNET_MARKET_PROFILE: MarketProfile = {
  symbol: "SOL-DEMO",
  name: "Valueless SOL-linked demo collateral",
  settlementFeedIdHex:
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  settlementSource: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  settlementExponent: -8,
  realtime: {
    provider: "pyth-lazer",
    feedId: "6",
    exponent: -8,
  },
};

export function marketProfileForCollateral(_mint: string): MarketProfile | null {
  return IS_DEVNET ? DEVNET_MARKET_PROFILE : null;
}

export function feedIdBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Oracle feed id must be 32 bytes");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
