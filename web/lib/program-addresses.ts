import { PublicKey } from "@solana/web3.js";

import factoryIdl from "./idl/factory.json";
import marketIdl from "./idl/market.json";
import oracleIdl from "./idl/oracle_adapter.json";
import seriesIdl from "./idl/series.json";

const configured = (value: string | undefined, fallback: string) =>
  new PublicKey(value?.trim() || fallback);

/** Program addresses are deployment configuration, never product logic. */
export const SERIES_PROGRAM = configured(
  process.env.NEXT_PUBLIC_SERIES_PROGRAM_ID,
  seriesIdl.address,
);
export const FACTORY_PROGRAM = configured(
  process.env.NEXT_PUBLIC_FACTORY_PROGRAM_ID,
  factoryIdl.address,
);
export const ORACLE_ADAPTER_PROGRAM = configured(
  process.env.NEXT_PUBLIC_ORACLE_ADAPTER_PROGRAM_ID,
  oracleIdl.address,
);
export const MARKET_PROGRAM = configured(
  process.env.NEXT_PUBLIC_MARKET_PROGRAM_ID,
  marketIdl.address,
);

export const idlAt = <T extends { address: string }>(idl: T, address: PublicKey): T =>
  ({ ...idl, address: address.toBase58() });
