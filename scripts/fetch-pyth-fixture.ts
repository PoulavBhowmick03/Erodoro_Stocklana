// SPDX-License-Identifier: Apache-2.0
//
// Build validator fixtures from a real Pyth price account.
//
// There is no mock-oracle program in this repo. Every local test that needs a
// price starts from a genuine `PriceUpdateV2` account fetched from devnet, then
// rewrites three fields per scenario: price, feed id, and publish time. Those
// mutations invalidate the original Wormhole attestation. Loading the result
// under the receiver owner exercises the account layout and contract checks;
// it does not reproduce Pyth receiver verification.
//
// Why those three:
//
//   price        so a test can settle above, below or at a strike.
//   feed_id      so each scenario gets its own FeedConfig and cannot be
//                accidentally settled against by another test.
//   publish_time because settlement needs a quote at or after a maturity that
//                must itself be in the future when the series is created. A
//                frozen snapshot can never satisfy both. Pyth is a pull
//                oracle — in production the update is posted in the settling
//                transaction, so publish_time really is ~now — and shifting it
//                forward reproduces exactly that.
//
// Everything else is untouched: the discriminator, the write authority, the
// recorded verification-level tag, the exponent, conf, EMA fields and the
// account owner used by the local validator fixture.
//
//   pnpm pyth:fixture

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const SOURCE = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const OUT_DIR = path.resolve(process.cwd(), "tests", "fixtures");

/** How far ahead of now each snapshot's publish time is placed. */
const PUBLISH_OFFSET_SECS = 75;

/** 8-decimal USD, matching the exponent the real feed reports. */
const USD = 100_000_000;

/**
 * One account per price the tests need.
 *
 * `stale` is the exception: its publish time is left far in the past so the
 * settlement window and freshness checks have something real to reject.
 */
const SCENARIOS: {
  name: string;
  price: number;
  stale?: boolean;
  /**
   * Borrow another scenario's feed id instead of deriving a fresh one.
   *
   * The default of one feed id per scenario is what keeps tests from settling
   * against each other, but it leaves no two accounts that a feed config would
   * accept interchangeably -- and `set_source` exists precisely to swap between
   * them. Rotating a source may not change the feed, so proving the happy path
   * needs a second address carrying the *same* feed id.
   */
  feedAlias?: string;
  /**
   * Stamp the publish time this many seconds *before* now instead of after.
   *
   * The default `+PUBLISH_OFFSET_SECS` exists so settlement tests can reach a
   * maturity that was still in the future when the series was created. A quote
   * read directly, though, is rejected outright when its publish time is ahead
   * of the clock -- so anything exercising `preview_quote` needs the opposite.
   */
  pastSecs?: number;
}[] = [
  { name: "at-250", price: 250 * USD },
  { name: "at-300", price: 300 * USD },
  { name: "at-600", price: 600 * USD },
  { name: "at-600-alt", price: 600 * USD, feedAlias: "at-600" },
  { name: "at-600-past", price: 600 * USD, feedAlias: "at-600", pastSecs: 300 },
  { name: "at-1000", price: 1000 * USD },
  { name: "at-1200", price: 1200 * USD },
  { name: "live", price: 0 }, // price left exactly as fetched
  { name: "stale", price: 600 * USD, stale: true },
];

/** Deterministic address for a scenario, so Anchor.toml can name it. */
export const fixtureKey = (name: string) =>
  Keypair.fromSeed(
    crypto.createHash("sha256").update(`erodoro:pyth:${name}`).digest().subarray(0, 32),
  ).publicKey;

async function main() {
  const url = process.env.PYTH_SOURCE_URL ?? "https://api.devnet.solana.com";
  const info = await new Connection(url, "confirmed").getAccountInfo(SOURCE);
  if (!info) throw new Error(`${SOURCE.toBase58()} not found on ${url}`);
  if (!info.owner.equals(RECEIVER)) {
    throw new Error(`unexpected owner ${info.owner.toBase58()}, wanted the Pyth receiver`);
  }

  // Layout: 8 discriminator, 32 write_authority, then the verification level —
  // one byte for Full, two for Partial — then the price message.
  const tag = info.data.readUInt8(40);
  const msg = tag === 0 ? 42 : 41;
  const FEED_ID = msg;
  const PRICE = msg + 32;
  const EXPO = msg + 48;
  const PUBLISH = msg + 52;
  const PREV_PUBLISH = msg + 60;

  const now = Math.floor(Date.now() / 1000);
  const expo = info.data.readInt32LE(EXPO);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest: Record<string, { address: string; price: number; publishTime: number }> = {};

  for (const s of SCENARIOS) {
    const data = Buffer.from(info.data);
    const address = fixtureKey(s.name);

    if (s.price > 0) data.writeBigInt64LE(BigInt(s.price), PRICE);

    // A distinct feed id per scenario, derived so it is stable across runs --
    // unless the scenario deliberately aliases another's.
    const feedId = crypto
      .createHash("sha256")
      .update(`erodoro:feed:${s.feedAlias ?? s.name}`)
      .digest();
    feedId.copy(data, FEED_ID, 0, 32);

    const publish = s.stale
      ? now - 86_400
      : s.pastSecs !== undefined
        ? now - s.pastSecs
        : now + PUBLISH_OFFSET_SECS;
    const delta = publish - Number(info.data.readBigInt64LE(PUBLISH));
    data.writeBigInt64LE(BigInt(publish), PUBLISH);
    data.writeBigInt64LE(
      BigInt(Number(info.data.readBigInt64LE(PREV_PUBLISH)) + delta),
      PREV_PUBLISH,
    );

    fs.writeFileSync(
      path.join(OUT_DIR, `pyth-${s.name}.json`),
      JSON.stringify(
        {
          pubkey: address.toBase58(),
          account: {
            lamports: info.lamports,
            data: [data.toString("base64"), "base64"],
            owner: RECEIVER.toBase58(),
            executable: false,
            rentEpoch: 0,
            space: data.length,
          },
        },
        null,
        2,
      ),
    );

    manifest[s.name] = {
      address: address.toBase58(),
      price: Number(data.readBigInt64LE(PRICE)),
      publishTime: publish,
    };
  }

  fs.writeFileSync(path.join(OUT_DIR, "pyth-manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`pyth fixtures -> ${OUT_DIR} (exponent ${expo}, +${PUBLISH_OFFSET_SECS}s)`);
  for (const [name, m] of Object.entries(manifest)) {
    console.log(`  ${name.padEnd(8)} $${(m.price / USD).toFixed(2).padStart(9)}  ${m.address}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
