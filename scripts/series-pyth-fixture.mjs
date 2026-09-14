// SPDX-License-Identifier: Apache-2.0
//
// Fresh Pyth fixture for the series lifecycle tier.
//
// `tests/series-lifecycle.ts` settles a real series against a quote, which
// needs a publish time *after* the series' maturity but *before* settlement —
// a window no committed fixture can straddle on every run. So the Makefile
// target generates one account snapshot at validator startup with
// `publish = now + 45`, and the test creates (maturity `now + 10`), acts,
// sleeps past the print, then settles.
//
// Layout mirrors `PriceUpdateV2` exactly: discriminator, write authority,
// `Full` verification tag, feed message, posted slot. The attestation is not
// real — same caveat as every fixture under `tests/fixtures/` — and nothing
// here verifies signatures, only decoding and contract checks.
//
//   node scripts/series-pyth-fixture.mjs <out-path> [feed-id-hex] [price] [publish-in-secs]

import crypto from "node:crypto";
import fs from "node:fs";

const [out, feedIdHex, priceArg, publishInArg] = process.argv.slice(2);
if (!out) {
  console.error("usage: series-pyth-fixture.mjs <out-path> [feed-id-hex] [price] [publish-in-secs]");
  process.exit(1);
}

const feedId = feedIdHex
  ? Buffer.from(feedIdHex, "hex")
  : crypto.createHash("sha256").update("erodoro:series-lifecycle").digest();
const price = BigInt(priceArg ?? 600_00000000);
const publish = Math.floor(Date.now() / 1000) + Number(publishInArg ?? 75);

// sha256("account:PriceUpdateV2")[..8]
const disc = crypto
  .createHash("sha256")
  .update("account:PriceUpdateV2")
  .digest()
  .subarray(0, 8);

const buf = Buffer.alloc(133);
let o = 0;
disc.copy(buf.subarray(o, o + 8));
o += 8;
buf.fill(0, o, o + 32); // write authority: unchecked by every decoder here
o += 32;
buf[o++] = 1; // VerificationLevel::Full
feedId.copy(buf.subarray(o, o + 32));
o += 32;
buf.writeBigInt64LE(price, o);
o += 8;
buf.writeBigUInt64LE(1_000000n, o); // conf
o += 8;
buf.writeInt32LE(-8, o); // expo
o += 4;
buf.writeBigInt64LE(BigInt(publish), o);
o += 8;
buf.writeBigInt64LE(BigInt(publish - 60), o); // prev publish
o += 8;
buf.writeBigInt64LE(price, o); // ema
o += 8;
buf.writeBigUInt64LE(1_000000n, o);
o += 8;
buf.writeBigUInt64LE(300_000_000n, o); // posted slot
o += 8;
if (o !== 133) throw new Error("layout drifted");

const account = {
  pubkey: "5UwXgaBafMgP2NV8x2rKvWU67ehJzHpCoBbcHsb6w1VF",
  account: {
    lamports: (128 + 133) * 6960,
    data: [buf.toString("base64"), "base64"],
    owner: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    executable: false,
    rentEpoch: 0,
    space: 133,
  },
};
fs.writeFileSync(out, JSON.stringify(account));
console.log(`series pyth fixture: publish=${publish} price=${price} -> ${out}`);
