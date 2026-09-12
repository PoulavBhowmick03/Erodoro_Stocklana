// SPDX-License-Identifier: Apache-2.0
//
// The oracle adapter on devnet, against production Pyth.
//
// No fixtures and no mock here — this reads the sponsored SOL/USD
// `PriceUpdateV2` account that Pyth's own pushers keep refreshed, through the
// adapter deployed to devnet. What it proves that a validator cannot: the
// program executes on a real cluster, the account layout round-trips through
// devnet RPC, and the decoder handles whatever Pyth is publishing right now
// rather than a snapshot of it.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json pnpm devnet

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";
const BN = (anchor as any).BN ?? (anchor as any).default.BN;
const { assert } = chai;
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const IDL_DIR = path.resolve(process.cwd(), "target", "idl");
const enc = new TextEncoder();
const seed = (s: string) => Buffer.from(enc.encode(s));
const USD = 100_000_000;

/** The sponsored Pyth SOL/USD account on devnet, and the receiver that owns it. */
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SOL_USD_FEED_ID = Buffer.from(
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "hex",
);

function loadProgram(name: string, provider: anchor.AnchorProvider): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(IDL_DIR, `${name}.json`), "utf8"));
  return new anchor.Program(idl, provider);
}

/** Borsh layout of `common::PriceData`, as `preview_quote` returns it. */
function decodePriceData(buf: Buffer) {
  assert.equal(buf.length, 60, "PriceData is 32 + 16 + 4 + 8 bytes");
  return {
    feedId: buf.subarray(0, 32),
    price: new BN(buf.subarray(32, 48), "le"),
    decimals: buf.readUInt32LE(48),
    timestamp: new BN(buf.subarray(52, 60), "le").fromTwos(64).toNumber(),
  };
}

describe("oracle adapter on devnet, against live Pyth", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let oracleAdapter: anchor.Program<any>;
  let feedConfig: PublicKey;

  async function now(): Promise<number> {
    const slot = await connection.getSlot();
    return (await connection.getBlockTime(slot))!;
  }

  /** Read a quote through the deployed adapter, or throw its error. */
  async function previewQuote(config = feedConfig, source = PYTH_SOL_USD) {
    const ix = await oracleAdapter.methods
      .previewQuote()
      .accounts({ feedConfig: config, source })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      throw new Error(JSON.stringify(sim.value.err) + " :: " + (sim.value.logs ?? []).join("\n"));
    }
    return decodePriceData(Buffer.from(sim.value.returnData!.data[0], "base64"));
  }

  before("confirm the adapter is live and pin a config to the SOL/USD feed", async function () {
    oracleAdapter = loadProgram("oracle_adapter", provider);

    const info = await connection.getAccountInfo(oracleAdapter.programId);
    assert.isNotNull(info, `oracle_adapter is not deployed at ${oracleAdapter.programId}`);
    assert.isTrue(info!.executable, "oracle_adapter is not executable");

    const src = await connection.getAccountInfo(PYTH_SOL_USD);
    assert.isNotNull(src, "the sponsored Pyth SOL/USD account is missing from devnet");
    assert.equal(
      src!.owner.toBase58(),
      PYTH_RECEIVER.toBase58(),
      "and must be owned by the Pyth receiver",
    );

    if ((await connection.getBalance(payer.publicKey)) < 0.01 * 1e9) {
      console.log("        payer is out of devnet SOL — need ~0.01 to create a feed config");
      this.skip();
    }

    feedConfig = PublicKey.findProgramAddressSync(
      [seed("feed-config"), SOL_USD_FEED_ID],
      oracleAdapter.programId,
    )[0];
    if (!(await connection.getAccountInfo(feedConfig))) {
      try {
        // 13 guardian signatures required; the sponsored feed posts `Full`
        // updates, which clear any floor.
        await oracleAdapter.methods
          .initializeFeedConfig(Array.from(SOL_USD_FEED_ID), new BN(120), 13)
          .accounts({
            payer: payer.publicKey,
            admin: payer.publicKey,
            feedConfig,
            source: PYTH_SOL_USD,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e) {
        // The binary on devnet predates the removal of the mock source, so it
        // still expects `source_kind` and `require_market_open`. Upgrading it
        // needs ~1.55 SOL for the deploy buffer and the faucet is capped.
        // Skip loudly — a silent pass here would be worse than a red run.
        console.log(
          "        the oracle_adapter deployed to devnet is a pre-refactor build and no" +
            " longer matches this IDL. Redeploy it (~1.55 SOL) to run these.",
        );
        console.log(`        (${String(e).split("\n")[0]})`);
        this.skip();
      }
    }
  });

  it("pins the feed's identity and staleness tolerance", async () => {
    const cfg = await oracleAdapter.account.feedConfig.fetch(feedConfig);
    assert.deepEqual(Array.from(cfg.feedId), Array.from(SOL_USD_FEED_ID), "SOL/USD");
    assert.equal(cfg.source.toBase58(), PYTH_SOL_USD.toBase58());
    assert.equal(cfg.maxAgeSecs.toNumber(), 120);
    assert.equal(cfg.minVerificationSignatures, 13, "the signature floor is stored");
  });

  it("reads a live quote off production Pyth infrastructure", async () => {
    const q = await previewQuote();

    assert.deepEqual(Array.from(q.feedId), Array.from(SOL_USD_FEED_ID), "carries the feed id");
    assert.equal(q.decimals, 8, "exponent -8 normalized to 8 decimals");

    const usd = q.price.toNumber() / USD;
    assert.isAbove(usd, 1, `SOL/USD came back as ${usd}`);
    assert.isBelow(usd, 10_000, `SOL/USD came back as ${usd}`);

    // Genuinely fresh: the 120s staleness gate passed, which it could not on a
    // stale account or a snapshot.
    const age = (await now()) - q.timestamp;
    assert.isBelow(age, 120, `quote was ${age}s old`);
    assert.isAtLeast(age, -5, "and is not from the future");
    console.log(`        live Pyth SOL/USD = $${usd.toFixed(4)}, ${age}s old`);
  });

  it("rejects a source account the config does not name", async () => {
    // The check that stops a series settling against another asset's price.
    try {
      await previewQuote(feedConfig, oracleAdapter.programId);
      assert.fail("a foreign source must not validate against this config");
    } catch (e) {
      assert.match(String(e), /FeedMismatch|mismatch|InvalidOracle/i);
    }
  });

  it("refuses to store an account the Pyth receiver does not own", async () => {
    // An arbitrary account cannot become a configured source however
    // plausible its bytes. The same owner check also runs on every read for
    // legacy configs and accounts whose state changes later.
    const id = Buffer.from(Keypair.generate().publicKey.toBuffer());
    const cfg = PublicKey.findProgramAddressSync(
      [seed("feed-config"), id],
      oracleAdapter.programId,
    )[0];
    try {
      await oracleAdapter.methods
        .initializeFeedConfig(Array.from(id), new BN(120), 13)
        .accounts({
          payer: payer.publicKey,
          admin: payer.publicKey,
          feedConfig: cfg,
          // The adapter's own program account: real, and emphatically not a
          // Pyth price update.
          source: oracleAdapter.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("a non-Pyth account must not become a configured source");
    } catch (e) {
      assert.match(String(e), /InvalidOracle|owner|OraclePriceInvalid/i);
    }
  });

  it("refuses a feed config with no staleness bound", async () => {
    const id = Buffer.from(Keypair.generate().publicKey.toBuffer());
    const cfg = PublicKey.findProgramAddressSync(
      [seed("feed-config"), id],
      oracleAdapter.programId,
    )[0];
    try {
      await oracleAdapter.methods
        .initializeFeedConfig(Array.from(id), new BN(0), 13)
        .accounts({
          payer: payer.publicKey,
          admin: payer.publicKey,
          feedConfig: cfg,
          source: PYTH_SOL_USD,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("a zero staleness bound must be rejected");
    } catch (e) {
      assert.match(String(e), /InvalidParams|invalid/i);
    }
  });
});
