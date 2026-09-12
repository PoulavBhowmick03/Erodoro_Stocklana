import assert from "node:assert/strict";
import test from "node:test";

import { decodeMagicBlockPrice, magicBlockPriceAddress } from "../lib/magicblock-price.ts";

const SOL_LAZER_PROFILE = { provider: "pyth-lazer", feedId: "6", exponent: -8 };

test("SOL Pyth Lazer profile derives the published MagicBlock account", () => {
  assert.equal(
    magicBlockPriceAddress(SOL_LAZER_PROFILE).toBase58(),
    "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
  );
});

test("MagicBlock price decoder reads the documented stable offsets", () => {
  const bytes = new Uint8Array(134);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(73, 18_765_432_100n, true);
  view.setBigInt64(93, 1_777_000_000n, true);

  const quote = decodeMagicBlockPrice(bytes, -8);
  assert.equal(quote.rawPrice, 18_765_432_100n);
  assert.equal(quote.price, 187.654321);
  assert.equal(quote.publishTime, 1_777_000_000);
});

test("MagicBlock price decoder rejects truncated or non-positive prices", () => {
  assert.throws(() => decodeMagicBlockPrice(new Uint8Array(100), -8), /truncated/);
  assert.throws(() => decodeMagicBlockPrice(new Uint8Array(134), -8), /invalid/);
});
