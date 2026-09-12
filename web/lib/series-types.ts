import type { PublicKey } from "@solana/web3.js";
import type { BN } from "@coral-xyz/anchor";

/**
 * The on-chain accounts, typed.
 *
 * These mirror the IDLs in `lib/idl/` field for field. Anchor hands back
 * `camelCase` for the `snake_case` names the Rust declares, and `i128` / `u128`
 * arrive as `BN` rather than `bigint`, which is why every wide integer below is
 * a `BN`.
 *
 * They exist because the markets table sorts and filters on these fields, and
 * `any` makes every one of those a silent typo away from a blank column.
 */

/** `series::SeriesStatus`, as Anchor encodes a fieldless enum. */
export type SeriesStatus =
  | { open: Record<string, never> }
  | { paused: Record<string, never> }
  | { settled: Record<string, never> };

/** `series::SeriesConfig`. */
export type SeriesConfig = {
  factory: PublicKey;
  admin: PublicKey;
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  oracleAdapter: PublicKey;
  pMint: PublicKey;
  nMint: PublicKey;
  strike: BN;
  priceDecimals: number;
  collateralDecimals: number;
  multiplierAtCreation: BN;
  maturityTs: BN;
  settlementDelaySecs: BN;
  maxOracleAgeSecs: BN;
  maxPriceLagSecs: BN;
  minSplitAmount: BN;
  feeBps: number;
  feeRecipient: PublicKey;
  status: SeriesStatus;
  bump: number;
};

/** `series::Settlement`, written once when a series settles. */
export type Settlement = {
  series: PublicKey;
  price: BN;
  priceDecimals: number;
  priceTs: BN;
  settledTs: BN;
  collateralAtSettlement: BN;
  pSupplyAtSettlement: BN;
  nSupplyAtSettlement: BN;
  pPool: BN;
  nPool: BN;
  pRedeemed: BN;
  nRedeemed: BN;
  pPaid: BN;
  nPaid: BN;
  multiplierAtSettlement: BN;
  effectiveStrike: BN;
  shortfallObserved: boolean;
  supplyMismatch: boolean;
  bump: number;
};

/** `factory::SeriesRecord` — the registry entry that makes a series canonical. */
export type SeriesRecord = {
  series: PublicKey;
  collateralMint: PublicKey;
  feedConfig: PublicKey;
  strike: BN;
  maturityTs: BN;
  priceDecimals: number;
  /** Creation order. The only thing that can say which series are new. */
  index: BN;
  bump: number;
};

/** One row of the markets table. */
export type SeriesView = {
  address: PublicKey;
  config: SeriesConfig;
  settlement: Settlement | null;
  /** The registry entry this was listed from. */
  record: SeriesRecord;
};
