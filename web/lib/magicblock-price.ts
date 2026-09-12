import { PublicKey } from "@solana/web3.js";

import type { RealtimePriceProfile } from "./market-profile";

export const MAGICBLOCK_PRICE_PROGRAM = new PublicKey(
  "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd",
);

const PRICE_OFFSET = 73;
const PUBLISH_TIME_OFFSET = 93;
const MIN_ACCOUNT_SIZE = PUBLISH_TIME_OFFSET + 8;

export function magicBlockPriceAddress(profile: RealtimePriceProfile): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("price_feed"),
      Buffer.from(profile.provider),
      Buffer.from(profile.feedId),
    ],
    MAGICBLOCK_PRICE_PROGRAM,
  )[0];
}

/** Decode the stable fields documented by MagicBlock's real-time oracle. */
export function decodeMagicBlockPrice(
  data: Uint8Array,
  exponent: number,
): { rawPrice: bigint; price: number; publishTime: number } {
  if (data.byteLength < MIN_ACCOUNT_SIZE) throw new Error("MagicBlock price account is truncated");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawPrice = view.getBigInt64(PRICE_OFFSET, true);
  const publishTime = Number(view.getBigInt64(PUBLISH_TIME_OFFSET, true));
  const price = Number(rawPrice) * 10 ** exponent;
  if (!Number.isFinite(price) || price <= 0) throw new Error("MagicBlock price is invalid");
  if (!Number.isSafeInteger(publishTime) || publishTime <= 0) {
    throw new Error("MagicBlock publish time is invalid");
  }
  return { rawPrice, price, publishTime };
}
