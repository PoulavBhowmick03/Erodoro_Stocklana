// SPDX-License-Identifier: Apache-2.0
//
// The Pinocchio build of the oracle adapter, executed on a validator.
//
// `variants/oracle-adapter-pinocchio` has 43 tests, and every one of them is
// pure logic: the Pyth decoder, exponent scaling, the account layout, the
// discriminators. None of it has ever *run*. The PDA derivation, the
// CreateAccount CPI, the rent lookup and the return-data path have only ever
// been reasoned about.
//
// That matters because deploying it is an upgrade of the program that owns
// every FeedConfig account. A bug in `initialize_feed_config` is found after
// the SOL is spent, not before.
//
// So this drives it the way a client would, with hand-built instructions
// rather than an IDL — the Pinocchio build has no IDL, which is itself part of
// what is being checked: a client written against the *Anchor* IDL has to
// reach this program unchanged.
//
//   anchor test --skip-build   (with tests/pinocchio-oracle.ts in the run)

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";
const { assert } = chai;
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/** Fixture accounts the validator preloads, at 8 decimals. */
const PYTH_AT_600 = new PublicKey("5UwXgaBafMgP2NV8x2rKvWU67ehJzHpCoBbcHsb6w1VF");
const PYTH_AT_300 = new PublicKey("5L1pifLzp6N71UvLUuvXDqTQfQKrJDWQTQQnWHJSsW6M");
/**
 * Same feed id as `PYTH_AT_600`, different address -- the only kind of account
 * `set_source` will accept as a replacement, since rotating the source may not
 * change the feed. Every other fixture derives its own feed id.
 */
const PYTH_AT_600_ALT = new PublicKey("81x6PaZzbDX1gHVCGnrpW9N6gDVqgAY5qmuk4yRo6bkC");
/**
 * Same feed again, but stamped *behind* the clock. `read_quote` rejects a
 * publish time ahead of now, and the ordinary fixtures are deliberately dated
 * forward so settlement tests can reach a future maturity -- so this is the
 * only one a quote can actually be read through. Without it this suite passes
 * only while the committed fixtures happen to be stale.
 */
const PYTH_AT_600_PAST = new PublicKey("EHogBYxtkS8XJu88EDfAyxzA4eF9QzyrKMdFE5rTER5f");

const FEED_CONFIG_SEED = Buffer.from("feed-config");
const FEED_CONFIG_LEN = 114;

/**
 * Anchor's discriminators, derived rather than transcribed.
 *
 * The Pinocchio build hardcodes these. If it and this test ever disagree, a
 * client built against the Anchor IDL would silently fail to reach the
 * program, which is the exact failure this file exists to rule out.
 */
const disc = (preimage: string) =>
  createHash("sha256").update(preimage).digest().subarray(0, 8);

const IX = {
  initialize: disc("global:initialize_feed_config"),
  setSource: disc("global:set_source"),
  setAdmin: disc("global:set_admin"),
  previewQuote: disc("global:preview_quote"),
};
const FEED_CONFIG_DISCRIMINATOR = disc("account:FeedConfig");

/** The layout `oracle_adapter::FeedConfig` writes, read back by hand. */
function decodeFeedConfig(data: Buffer) {
  assert.isAtLeast(data.length, FEED_CONFIG_LEN, "account is at least 114 bytes");
  assert.deepEqual(
    Uint8Array.from(data.subarray(0, 8)),
    Uint8Array.from(FEED_CONFIG_DISCRIMINATOR),
    "discriminator must be Anchor's, so `Account<FeedConfig>` accepts it",
  );
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    feedId: data.subarray(40, 72),
    source: new PublicKey(data.subarray(72, 104)),
    maxAgeSecs: data.readBigInt64LE(104),
    minVerificationSignatures: data[112],
    bump: data[113],
  };
}

/** `PriceData` as `preview_quote` sets it in return data. */
function decodePriceData(buf: Buffer) {
  assert.equal(buf.length, 60, "PriceData is 32 + 16 + 4 + 8 bytes");
  return {
    feedId: buf.subarray(0, 32),
    price: buf.subarray(32, 48),
    decimals: buf.readUInt32LE(48),
    timestamp: buf.readBigInt64LE(52),
  };
}

describe("oracle adapter, Pinocchio build, on a validator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Read from the fixture rather than assumed. `scripts/fetch-pyth-fixture.ts`
  // rewrites the feed id per scenario, so hardcoding one here would pass or
  // fail for reasons that have nothing to do with the program.
  const fixture = (() => {
    const acct = JSON.parse(
      fs.readFileSync(path.join("tests", "fixtures", "pyth-at-600-past.json"), "utf8"),
    );
    const data = Buffer.from(acct.account.data[0], "base64");
    const tag = data[40]; // 0 = Partial (carries a signature count), 1 = Full
    const off = 41 + (tag === 0 ? 1 : 0);
    // feed_id(32) price(i64) conf(u64) exponent(i32) publish_time(i64)
    return {
      feedId: data.subarray(off, off + 32),
      price: data.readBigInt64LE(off + 32),
      exponent: data.readInt32LE(off + 48),
      publishTime: data.readBigInt64LE(off + 52),
    };
  })();
  const feedId = fixture.feedId;

  // Sized from the fixture's own publish time rather than fixed.
  //
  // `scripts/fetch-pyth-fixture.ts` stamps these when it runs, so any constant
  // here turns into a test that passes today and fails in a month for a reason
  // that has nothing to do with the program. Staleness itself is covered by the
  // unit tests, which control the clock.
  const maxAgeSecs =
    BigInt(Math.floor(Date.now() / 1000)) - fixture.publishTime + 86_400n;
  let feedConfig: PublicKey;
  let bump: number;

  before(async function () {
    const info = await connection.getAccountInfo(PROGRAM_ID);
    if (!info?.executable) {
      console.log(
        "        oracle adapter not deployed to this validator — deploy the " +
          "Pinocchio build to FMByTd4Jr… first",
      );
      this.skip();
    }
    [feedConfig, bump] = PublicKey.findProgramAddressSync(
      [FEED_CONFIG_SEED, feedId],
      PROGRAM_ID,
    );
  });

  const send = (ix: TransactionInstruction, signers: Keypair[] = []) =>
    provider.sendAndConfirm(new Transaction().add(ix), signers);

  it("creates a feed config at the PDA the Anchor build would derive", async () => {
    const data = Buffer.concat([
      IX.initialize,
      feedId,
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(maxAgeSecs);
        return b;
      })(),
      Buffer.from([13]), // min_verification_signatures
    ]);

    await send(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // admin
          { pubkey: feedConfig, isSigner: false, isWritable: true },
          { pubkey: PYTH_AT_600_PAST, isSigner: false, isWritable: false }, // source
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }),
    );

    const info = await connection.getAccountInfo(feedConfig);
    assert.isNotNull(info, "the CreateAccount CPI actually ran");
    assert.isTrue(info!.owner.equals(PROGRAM_ID), "owned by the adapter");
    assert.equal(info!.data.length, FEED_CONFIG_LEN, "exactly 114 bytes");

    const cfg = decodeFeedConfig(info!.data);
    assert.isTrue(cfg.admin.equals(payer.publicKey));
    assert.deepEqual(Uint8Array.from(cfg.feedId), Uint8Array.from(feedId));
    assert.isTrue(cfg.source.equals(PYTH_AT_600_PAST));
    assert.equal(cfg.maxAgeSecs, maxAgeSecs);
    assert.equal(cfg.minVerificationSignatures, 13);
    assert.equal(cfg.bump, bump, "stores the canonical bump it derived");
  });

  it("refuses a non-positive max age", async () => {
    const other = Buffer.alloc(32, 7);
    const [pda] = PublicKey.findProgramAddressSync(
      [FEED_CONFIG_SEED, other],
      PROGRAM_ID,
    );
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(0n);
    try {
      await send(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: pda, isSigner: false, isWritable: true },
            { pubkey: PYTH_AT_600_PAST, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([IX.initialize, other, b, Buffer.from([0])]),
        }),
      );
      assert.fail("a zero max_age_secs must be refused");
    } catch (e: any) {
      assert.match(String(e), /6026|InvalidParams|custom program error/i);
    }
  });

  it("reads a quote through preview_quote and returns it as PriceData", async () => {
    // Read through a simulation rather than a confirmed transaction's meta:
    // return data is a transient per-instruction buffer, and `getTransaction`
    // does not surface it for a top-level instruction. This is the same way
    // `tests/devnet-oracle.ts` reads the Anchor build's `preview_quote`.
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: feedConfig, isSigner: false, isWritable: false },
          { pubkey: PYTH_AT_600_PAST, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(IX.previewQuote),
      }),
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx);
    assert.isNull(sim.value.err, (sim.value.logs ?? []).join("\n"));

    const ret = sim.value.returnData;
    assert.isOk(ret, "preview_quote must set return data");
    assert.equal(new PublicKey(ret!.programId).toBase58(), PROGRAM_ID.toBase58());

    const quote = decodePriceData(Buffer.from(ret!.data[0], "base64"));
    assert.deepEqual(
      Uint8Array.from(quote.feedId),
      Uint8Array.from(feedId),
      "the quote's own feed id is checked against the config",
    );
    assert.equal(quote.decimals, 8, "the fixtures report exponent -8");
    assert.equal(
      quote.price.readBigInt64LE(0),
      fixture.price,
      "the price the fixture carries, decoded unchanged",
    );
  });

  it("rejects a source the config does not name", async () => {
    try {
      await send(
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: feedConfig, isSigner: false, isWritable: false },
            { pubkey: PYTH_AT_300, isSigner: false, isWritable: false },
          ],
          data: Buffer.from(IX.previewQuote),
        }),
      );
      assert.fail("a source other than the configured one must be refused");
    } catch (e: any) {
      // 6035 FeedMismatch
      assert.match(String(e), /6035|FeedMismatch|custom program error/i);
    }
  });

  it("rotates the source, but only for the admin", async () => {
    const stranger = Keypair.generate();
    // Use the suite's funded payer and normal transaction confirmation path.
    await send(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 1_000_000_000,
      }),
    );

    const rotate = (signer: PublicKey, source: PublicKey) =>
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: signer, isSigner: true, isWritable: false },
          { pubkey: feedConfig, isSigner: false, isWritable: true },
          { pubkey: source, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(IX.setSource),
      });

    try {
      await send(rotate(stranger.publicKey, PYTH_AT_600_ALT), [stranger]);
      assert.fail("a non-admin must not rotate the source");
    } catch (e: any) {
      // 6002 Unauthorized
      assert.match(String(e), /6002|Unauthorized|custom program error/i);
    }

    // Even for the admin, the replacement must carry the config's own feed id.
    // `PYTH_AT_300` is a different feed, so this is refused rather than
    // silently repointing the config at another asset.
    try {
      await send(rotate(payer.publicKey, PYTH_AT_300));
      assert.fail("rotating to a source on a different feed must be refused");
    } catch (e: any) {
      // 6035 FeedMismatch
      assert.match(String(e), /6035|FeedMismatch|custom program error/i);
    }

    await send(rotate(payer.publicKey, PYTH_AT_600_ALT));
    const cfg = decodeFeedConfig((await connection.getAccountInfo(feedConfig))!.data);
    assert.isTrue(cfg.source.equals(PYTH_AT_600_ALT), "admin can rotate");
    assert.deepEqual(
      Uint8Array.from(cfg.feedId),
      Uint8Array.from(feedId),
      "rotating the account must never change the feed id",
    );
  });

  it("hands the admin over", async () => {
    const next = Keypair.generate();
    await send(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: feedConfig, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([IX.setAdmin, next.publicKey.toBuffer()]),
      }),
    );
    const cfg = decodeFeedConfig((await connection.getAccountInfo(feedConfig))!.data);
    assert.isTrue(cfg.admin.equals(next.publicKey));
  });
});
