#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Build-time gate: the browser's Pyth decoder must agree with the on-chain one.
//
// The vectors below are copied byte-for-byte from
// `programs/oracle-adapter/src/pyth.rs`, including a real devnet account. Same
// bytes, two languages, one expected answer — if the TypeScript path ever
// disagrees with the Rust path, a user would see a price the chain would not
// settle at, and nothing else in the build would notice.
//
// This imports the exact module the app ships (`lib/pyth-codec.mjs`), not a
// copy, so a green run says something about what deploys.

import assert from "node:assert/strict";
import {
  decodePriceUpdateV2,
  meetsFloor,
  scaleFromExpo,
  formatQuote,
  PYTH_RECEIVER_ID,
} from "../lib/pyth-codec.mjs";

let checks = 0;
const check = (name, fn) => {
  try {
    fn();
    checks++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

// `VerificationLevel::Partial { num_signatures: 5 }` — 134 bytes.
const GOLDEN_PARTIAL = Uint8Array.from([
  34, 241, 35, 99, 157, 126, 244, 205, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 0, 5, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 144, 47, 80, 9, 0, 0, 0, 57, 48, 0, 0, 0, 0, 0, 0,
  248, 255, 255, 255, 0, 120, 231, 104, 0, 0, 0, 0, 156, 119, 231, 104, 0, 0, 0, 0, 0, 175, 57, 74,
  9, 0, 0, 0, 231, 3, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0,
]);

// The same update as `Full` — one byte shorter, every field after the tag
// shifted. This is the vector a fixed-offset decoder fails.
const GOLDEN_FULL = Uint8Array.from([
  34, 241, 35, 99, 157, 126, 244, 205, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 144, 47, 80, 9, 0, 0, 0, 57, 48, 0, 0, 0, 0, 0, 0, 248,
  255, 255, 255, 0, 120, 231, 104, 0, 0, 0, 0, 156, 119, 231, 104, 0, 0, 0, 0, 0, 175, 57, 74, 9,
  0, 0, 0, 231, 3, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0,
]);

// A real devnet account (the sponsored SOL/USD feed), fetched 2026-08-13. 133
// bytes of `Full` payload in a 134-byte account: the receiver over-allocates.
const LIVE_DEVNET_SOL_USD = Uint8Array.from([
  34, 241, 35, 99, 157, 126, 244, 205, 96, 49, 71, 4, 52, 13, 237, 223, 55, 31, 212, 36, 114, 20,
  143, 36, 142, 157, 26, 109, 26, 94, 178, 172, 58, 205, 139, 127, 213, 214, 178, 67, 1, 239, 13,
  139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142, 208, 198, 199,
  188, 15, 76, 250, 200, 194, 128, 181, 109, 52, 230, 145, 197, 1, 0, 0, 0, 94, 85, 66, 0, 0, 0, 0,
  0, 248, 255, 255, 255, 183, 57, 126, 106, 0, 0, 0, 0, 183, 57, 126, 106, 0, 0, 0, 0, 240, 16, 156,
  197, 1, 0, 0, 0, 228, 240, 67, 0, 0, 0, 0, 0, 10, 15, 211, 28, 0, 0, 0, 0, 0,
]);

const EXPECTED = {
  price: 40000000000n,
  conf: 12345n,
  exponent: -8,
  publishTime: 1760000000n,
  prevPublishTime: 1759999900n,
  emaPrice: 39900000000n,
  emaConf: 999n,
  postedSlot: 42n,
};

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

check("decodes a partially-verified update", () => {
  const u = decodePriceUpdateV2(GOLDEN_PARTIAL);
  assert.equal(u.verificationLevel.partial, 5);
  assert.ok(sameBytes(u.feedId, new Uint8Array(32).fill(9)));
  for (const [k, v] of Object.entries(EXPECTED)) assert.equal(u[k], v, k);
});

check("decodes a fully-verified update, with every field shifted", () => {
  const u = decodePriceUpdateV2(GOLDEN_FULL);
  assert.equal(u.verificationLevel.full, true);
  for (const [k, v] of Object.entries(EXPECTED)) assert.equal(u[k], v, k);
});

check("decodes a real devnet account with a trailing byte", () => {
  const u = decodePriceUpdateV2(LIVE_DEVNET_SOL_USD);
  assert.equal(LIVE_DEVNET_SOL_USD.length, 134);
  assert.equal(u.verificationLevel.full, true);
  assert.equal(u.exponent, -8);
  assert.ok(u.price > 0n);
  assert.ok(u.publishTime > 1700000000n);
  assert.ok(u.prevPublishTime <= u.publishTime);
  const [price, decimals] = scaleFromExpo(u.price, u.exponent);
  assert.equal(decimals, 8);
  const dollars = price / 100000000n;
  assert.ok(dollars >= 70n && dollars < 90n, `SOL/USD out of band: ${dollars}`);
});

check("tolerates trailing bytes", () => {
  const padded = new Uint8Array(GOLDEN_FULL.length + 7);
  padded.set(GOLDEN_FULL);
  assert.equal(decodePriceUpdateV2(padded).verificationLevel.full, true);
});

check("rejects a foreign discriminator", () => {
  const bad = Uint8Array.from(GOLDEN_FULL);
  bad[0] ^= 0xff;
  assert.throws(() => decodePriceUpdateV2(bad));
});

check("rejects an unknown verification tag", () => {
  const bad = Uint8Array.from(GOLDEN_FULL);
  bad[40] = 2;
  assert.throws(() => decodePriceUpdateV2(bad));
});

check("rejects every truncation, and never hangs or returns junk", () => {
  for (let len = 0; len < GOLDEN_FULL.length; len++) {
    assert.throws(
      () => decodePriceUpdateV2(GOLDEN_FULL.subarray(0, len)),
      undefined,
      `a ${len}-byte account decoded`,
    );
  }
});

check("the signature floor is monotone and Full clears everything", () => {
  for (const sigs of [0, 1, 5, 12, 13, 255]) {
    for (const floor of [0, 1, 5, 12, 13, 255]) {
      assert.equal(meetsFloor({ partial: sigs }, floor), sigs >= floor);
    }
    assert.equal(meetsFloor({ full: true }, sigs), true);
  }
});

check("scaleFromExpo matches the Rust behaviour across its domain", () => {
  assert.deepEqual(scaleFromExpo(40000000000n, -8), [40000000000n, 8]);
  assert.deepEqual(scaleFromExpo(40000000n, -5), [40000000n, 5]);
  assert.deepEqual(scaleFromExpo(7n, 0), [7n, 0]);
  assert.deepEqual(scaleFromExpo(5n, 2), [500n, 0]);
  assert.deepEqual(scaleFromExpo(-5n, -2), [-5n, 2]);
  assert.throws(() => scaleFromExpo(1n, -19));
  assert.throws(() => scaleFromExpo(1n, 19));
  // The widest product the guard admits still works — the Rust side proves the
  // same thing, that this arm cannot overflow.
  const [wide] = scaleFromExpo(9223372036854775807n, 18);
  assert.equal(wide, 9223372036854775807n * 10n ** 18n);
});

check("formatQuote never routes through a float", () => {
  assert.equal(formatQuote(40000000000n, 8), "400.00");
  assert.equal(formatQuote(7654321000n, 8), "76.54");
  assert.equal(formatQuote(-40000000000n, 8), "-400.00");
  assert.equal(formatQuote(7n, 0), "7");
  // A value with more precision than a double can hold must survive exactly.
  assert.equal(formatQuote(123456789012345678901n, 18, 18), "123.456789012345678901");
});

check("the receiver id is 32 bytes", () => {
  assert.equal(PYTH_RECEIVER_ID.length, 32);
});

if (process.exitCode) {
  console.error("\noracle decoder does not match the on-chain implementation");
} else {
  console.log(`\n${checks} oracle decoder checks passed against the Rust vectors`);
}
