// SPDX-License-Identifier: Apache-2.0
//
// The Pinocchio build of the factory, executed on a validator.
//
// `variants/factory-pinocchio` has 24 conformance tests, and every one of them
// is pure logic: discriminators, layouts, policy verdicts, the CPI payload.
// None of them run the program. This does -- PDA derivation, the CreateAccount
// CPI, the rent lookup, Anchor's `close` semantics and the event log -- which
// is the tier that caught the rent bug in the oracle port and, once it was
// repaired, three test defects that a skipping suite had hidden for weeks.
//
// Instructions are built by hand rather than through an IDL: the Pinocchio
// build has no IDL, which is itself part of the point.
//
//   make pinocchio-factory
//
// `create_series` is deliberately not exercised here. Its CPI payload is
// proven byte-identical to Anchor's by proptest in the conformance suite, but
// standing up a Token-2022 collateral mint with the extension set the series
// program demands is the e2e suite's job, not this one's. That gap is real and
// is recorded in variants/COMPARISON.md.

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
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const FACTORY_ID = new PublicKey("CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ");
const ORACLE_ID = new PublicKey("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");

/** Past-dated fixture, so the feed config it backs can be read. */
const PYTH_AT_600_PAST = new PublicKey("EHogBYxtkS8XJu88EDfAyxzA4eF9QzyrKMdFE5rTER5f");

const FACTORY_SEED = Buffer.from("factory");
const ORACLE_SEED = Buffer.from("approved-oracle");
const COLLATERAL_SEED = Buffer.from("approved-collateral");
const FEED_CONFIG_SEED = Buffer.from("feed-config");

/** `sha256("global:<name>")[..8]`, derived rather than transcribed. */
const ixDisc = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const eventDisc = (name: string) =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

const IX = {
  initialize: ixDisc("initialize"),
  setAdmin: ixDisc("set_admin"),
  pauseCreation: ixDisc("pause_creation"),
  unpauseCreation: ixDisc("unpause_creation"),
  approveOracle: ixDisc("approve_oracle"),
  revokeOracle: ixDisc("revoke_oracle"),
  approveCollateral: ixDisc("approve_collateral"),
  revokeCollateral: ixDisc("revoke_collateral"),
  initializeFeedConfig: ixDisc("initialize_feed_config"),
};

/** Borsh layout of `FactoryState`, as this build writes it. */
function decodeFactoryState(data: Buffer) {
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    paused: data[40] !== 0,
    seriesCount: data.readBigUInt64LE(41),
    bump: data[49],
  };
}

/** Borsh layout of `Approval`. */
function decodeApproval(data: Buffer) {
  return { target: new PublicKey(data.subarray(8, 40)), bump: data[40] };
}

/** Pull an Anchor event out of the `Program data:` lines a tx emitted. */
function findEvent(logs: string[], disc: Buffer): Buffer | undefined {
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/);
    if (!m) continue;
    const raw = Buffer.from(m[1], "base64");
    if (raw.length >= 8 && raw.subarray(0, 8).equals(disc)) return raw;
  }
  return undefined;
}

describe("factory, Pinocchio build, on a validator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Read the feed id from the fixture rather than assuming it: the generator
  // rewrites it per scenario, so a hardcoded one would pass or fail for
  // reasons that have nothing to do with the program.
  const fixture = (() => {
    const acct = JSON.parse(
      fs.readFileSync(path.join("tests", "fixtures", "pyth-at-600-past.json"), "utf8"),
    );
    const data = Buffer.from(acct.account.data[0], "base64");
    const tag = data[40];
    const off = 41 + (tag === 0 ? 1 : 0);
    return { feedId: data.subarray(off, off + 32), publishTime: data.readBigInt64LE(off + 52) };
  })();

  const maxAgeSecs =
    BigInt(Math.floor(Date.now() / 1000)) - fixture.publishTime + 86_400n;

  let factoryPda: PublicKey;
  let feedConfig: PublicKey;
  let collateralMint: PublicKey;

  const send = (ix: TransactionInstruction, signers: Keypair[] = []) =>
    provider.sendAndConfirm(new Transaction().add(ix), signers);

  /**
   * Run the instruction and return its log lines.
   *
   * The logs come from a simulation, not from the confirmed transaction's
   * meta: `getTransaction` returns an empty `logMessages` for a freshly
   * confirmed transaction often enough to be useless, the same way it does not
   * surface return data. Simulating first and then sending executes the
   * instruction twice, which is harmless -- a simulation commits nothing -- and
   * is what makes the event assertions deterministic.
   */
  async function sendForLogs(ix: TransactionInstruction, signers: Keypair[] = []) {
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx, [payer, ...signers]);
    if (sim.value.err) {
      throw new Error(
        JSON.stringify(sim.value.err) + " :: " + (sim.value.logs ?? []).join("\n"),
      );
    }
    const logs = sim.value.logs ?? [];
    await send(ix, signers);
    return logs;
  }

  before(async function () {
    for (const [id, label] of [
      [FACTORY_ID, "factory"],
      [ORACLE_ID, "oracle adapter"],
    ] as const) {
      const info = await connection.getAccountInfo(id);
      if (!info?.executable) {
        console.log(`        ${label} not deployed to this validator — run 'make pinocchio-factory'`);
        this.skip();
      }
    }

    [factoryPda] = PublicKey.findProgramAddressSync([FACTORY_SEED], FACTORY_ID);
    [feedConfig] = PublicKey.findProgramAddressSync(
      [FEED_CONFIG_SEED, fixture.feedId],
      ORACLE_ID,
    );

    // A feed config for the factory to vouch for, created through the real
    // oracle adapter so `approve_oracle`'s owner and discriminator checks are
    // exercised against a genuine account rather than a forgery.
    const info = await connection.getAccountInfo(feedConfig);
    if (!info) {
      const data = Buffer.concat([
        IX.initializeFeedConfig,
        fixture.feedId,
        (() => {
          const b = Buffer.alloc(8);
          b.writeBigInt64LE(maxAgeSecs);
          return b;
        })(),
        // Must be > 0; the fixture is `Full`, which clears any floor.
        Buffer.from([1]), // min_verification_signatures
      ]);
      await send(
        new TransactionInstruction({
          programId: ORACLE_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: feedConfig, isSigner: false, isWritable: true },
            { pubkey: PYTH_AT_600_PAST, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }),
      );
    }

    collateralMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );
  });

  it("initializes the factory at the PDA the Anchor build would derive", async () => {
    await send(
      new TransactionInstruction({
        programId: FACTORY_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: factoryPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(IX.initialize),
      }),
    );

    const info = await connection.getAccountInfo(factoryPda);
    assert.isOk(info, "factory account created");
    assert.isTrue(info!.owner.equals(FACTORY_ID), "owned by the factory");
    assert.equal(info!.data.length, 50, "8 + InitSpace");

    const state = decodeFactoryState(info!.data);
    assert.isTrue(state.admin.equals(payer.publicKey));
    assert.isFalse(state.paused);
    assert.equal(state.seriesCount, 0n);

    // The stored bump must be the canonical one, or every later `seeds` check
    // that re-derives with it would fail.
    const [, bump] = PublicKey.findProgramAddressSync([FACTORY_SEED], FACTORY_ID);
    assert.equal(state.bump, bump);
  });

  it("pauses and unpauses, but only for the admin", async () => {
    const stranger = Keypair.generate();
    // Use the suite's funded payer and normal transaction confirmation path.
    await send(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 1_000_000_000,
      }),
    );

    const toggle = (disc: Buffer, signer: PublicKey) =>
      new TransactionInstruction({
        programId: FACTORY_ID,
        keys: [
          { pubkey: signer, isSigner: true, isWritable: false },
          { pubkey: factoryPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(disc),
      });

    try {
      await send(toggle(IX.pauseCreation, stranger.publicKey), [stranger]);
      assert.fail("a non-admin must not pause creation");
    } catch (e: any) {
      // 6002 Unauthorized
      assert.match(String(e), /6002|Unauthorized|custom program error/i);
    }

    await send(toggle(IX.pauseCreation, payer.publicKey));
    assert.isTrue(
      decodeFactoryState((await connection.getAccountInfo(factoryPda))!.data).paused,
    );

    await send(toggle(IX.unpauseCreation, payer.publicKey));
    assert.isFalse(
      decodeFactoryState((await connection.getAccountInfo(factoryPda))!.data).paused,
    );
  });

  it("approves an oracle, emitting the event Anchor would", async () => {
    const [approval] = PublicKey.findProgramAddressSync(
      [ORACLE_SEED, feedConfig.toBuffer()],
      FACTORY_ID,
    );

    const logs = await sendForLogs(
      new TransactionInstruction({
        programId: FACTORY_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: factoryPda, isSigner: false, isWritable: false },
          { pubkey: feedConfig, isSigner: false, isWritable: false },
          { pubkey: approval, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(IX.approveOracle),
      }),
    );

    const info = await connection.getAccountInfo(approval);
    assert.isOk(info, "approval created");
    assert.equal(info!.data.length, 41, "8 + InitSpace");
    const decoded = decodeApproval(info!.data);
    assert.isTrue(decoded.target.equals(feedConfig), "records what it vouches for");

    const ev = findEvent(logs, eventDisc("OracleApproved"));
    assert.isOk(ev, "OracleApproved emitted in Anchor's wire format");
    assert.isTrue(new PublicKey(ev!.subarray(8, 40)).equals(feedConfig));
  });

  it("refuses to vouch for an account the oracle adapter does not own", async () => {
    const impostor = Keypair.generate().publicKey;
    const [approval] = PublicKey.findProgramAddressSync(
      [ORACLE_SEED, impostor.toBuffer()],
      FACTORY_ID,
    );
    try {
      await send(
        new TransactionInstruction({
          programId: FACTORY_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: factoryPda, isSigner: false, isWritable: false },
            { pubkey: impostor, isSigner: false, isWritable: false },
            { pubkey: approval, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.from(IX.approveOracle),
        }),
      );
      assert.fail("a non-FeedConfig must not be approvable");
    } catch (e: any) {
      // Asserted on behaviour rather than on the wording of the RPC error:
      // this rejection is a `ProgramError::IllegalOwner`, which surfaces as
      // prose ("account does not have the expected owner") rather than as a
      // custom code, and that text is not part of the program's contract.
      assert.isNotNull(e);
    }
    assert.isNull(
      await connection.getAccountInfo(approval),
      "no approval may exist for an account the adapter does not own",
    );
  });

  it("approves and revokes collateral, refunding the rent", async () => {
    const [approval] = PublicKey.findProgramAddressSync(
      [COLLATERAL_SEED, collateralMint.toBuffer()],
      FACTORY_ID,
    );

    let logs = await sendForLogs(
      new TransactionInstruction({
        programId: FACTORY_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: factoryPda, isSigner: false, isWritable: false },
          { pubkey: collateralMint, isSigner: false, isWritable: false },
          { pubkey: approval, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(IX.approveCollateral),
      }),
    );
    assert.isOk(
      findEvent(logs, eventDisc("CollateralApproved")),
      "CollateralApproved emitted",
    );

    const rentHeld = (await connection.getAccountInfo(approval))!.lamports;
    assert.isAbove(rentHeld, 0);

    const recipient = Keypair.generate().publicKey;
    logs = await sendForLogs(
      new TransactionInstruction({
        programId: FACTORY_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: factoryPda, isSigner: false, isWritable: false },
          { pubkey: recipient, isSigner: false, isWritable: true },
          { pubkey: approval, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(IX.revokeCollateral),
      }),
    );

    // Anchor's `close`: the account is gone and its rent went to the recipient,
    // exactly, rather than being burned.
    const after = await connection.getAccountInfo(approval);
    assert.isTrue(after === null || after.data.length === 0, "approval closed");
    assert.equal(
      await connection.getBalance(recipient),
      rentHeld,
      "the rent lands on the recipient, to the lamport",
    );
    assert.isOk(findEvent(logs, eventDisc("CollateralRevoked")), "CollateralRevoked emitted");
  });

  it("hands the admin over", async () => {
    const next = Keypair.generate();
    await send(
      new TransactionInstruction({
        programId: FACTORY_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: factoryPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([IX.setAdmin, next.publicKey.toBuffer()]),
      }),
    );
    const state = decodeFactoryState((await connection.getAccountInfo(factoryPda))!.data);
    assert.isTrue(state.admin.equals(next.publicKey), "admin rotated");

    // And the old admin is now a stranger.
    try {
      await send(
        new TransactionInstruction({
          programId: FACTORY_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: factoryPda, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(IX.pauseCreation),
        }),
      );
      assert.fail("the previous admin must lose its powers");
    } catch (e: any) {
      assert.match(String(e), /6002|Unauthorized|custom program error/i);
    }
  });
});
