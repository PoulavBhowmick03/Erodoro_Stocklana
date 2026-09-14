// SPDX-License-Identifier: Apache-2.0
//
// The Pinocchio build of `series`, executed end to end on a validator.
//
// This tier runs the program: PDA derivation, ATA and mint creation, SPL and
// Token-2022 transfers in and out, the series PDA signing payouts, settlement
// against a Pyth-layout quote, and the Anchor event wire format. It drives the
// binary through the *Anchor TS client*, unchanged — same program ids, same
// IDL, same transactions the Anchor build executes. Any behavioral daylight
// between the two builds fails here.
//
//   make pinocchio-series
//
// What this does not cover: an armed transfer hook (no hook program exists on
// a plain validator; the hook path is proven byte-equal to SPL in
// `variants/series-pinocchio/tests/transfer_wire.rs`), and multisig
// authorities (same file). The MagicBlock delegation instructions do not exist
// on `series` at all.

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";
const { assert } = chai;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const BN = (anchor as any).BN ?? (anchor as any).default.BN;

const SERIES_ID = new PublicKey("AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9");
const ORACLE_ID = new PublicKey("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");
const PYTH_SOURCE = new PublicKey("5UwXgaBafMgP2NV8x2rKvWU67ehJzHpCoBbcHsb6w1VF");

const USD = 100_000_000;
const ONE_TOKEN = 100_000_000;
const FEED_ID = createHash("sha256").update("erodoro:series-lifecycle").digest();
const PRICE = 600 * USD;
const STRIKE = 500 * USD;

const seed = (s: string) => Buffer.from(s, "utf8");
const i128le = (v: any) => new BN(v).toTwos(128).toArrayLike(Buffer, "le", 16);
const i64le = (v: any) => new BN(v).toTwos(64).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eventDisc = (name: string) =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

function loadIdl(name: string): any {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "target/idl", `${name}.json`), "utf8"),
  );
}

function findEvent(logs: string[], disc: Buffer): Buffer | undefined {
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/);
    if (!m) continue;
    const raw = Buffer.from(m[1], "base64");
    if (raw.length >= 8 && raw.subarray(0, 8).equals(disc)) return raw;
  }
  return undefined;
}

describe("series, Pinocchio build, full lifecycle on a validator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection: Connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const series: any = new anchor.Program(loadIdl("series"), provider);
  const oracleAdapter: any = new anchor.Program(loadIdl("oracle_adapter"), provider);

  const holder = Keypair.generate();
  const issuer = Keypair.generate();

  let collateralMint: PublicKey;
  let holderCollateral: PublicKey;
  let feedConfig: PublicKey;
  let publishTime = 0;

  let s: PublicKey; // series A
  let vault: PublicKey;
  let pMint: PublicKey, nMint: PublicKey;
  let receiverP: PublicKey, receiverN: PublicKey;

  const seriesPda = (strike: number, maturity: number, creator = payer.publicKey) =>
    PublicKey.findProgramAddressSync(
      [seed("series"), creator.toBuffer(), collateralMint.toBuffer(), i128le(strike), i64le(maturity)],
      SERIES_ID,
    )[0];
  const pMintPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("p-mint"), s.toBuffer()], SERIES_ID)[0];
  const nMintPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("n-mint"), s.toBuffer()], SERIES_ID)[0];
  const settlementPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("settlement"), s.toBuffer()], SERIES_ID)[0];
  const vaultOf = (s: PublicKey) =>
    getAssociatedTokenAddressSync(collateralMint, s, true, TOKEN_2022_PROGRAM_ID);

  const balance = async (a: PublicKey, p = TOKEN_2022_PROGRAM_ID) =>
    Number((await getAccount(connection, a, undefined, p)).amount);

  /** Logs from a simulation; `getTransaction` does not reliably carry them. */
  async function sendForLogs(tx: Transaction, signers: Keypair[] = []) {
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx, [payer, ...signers]);
    if (sim.value.err) {
      throw new Error(
        JSON.stringify(sim.value.err) + " :: " + (sim.value.logs ?? []).join("\n"),
      );
    }
    const logs = sim.value.logs ?? [];
    await provider.sendAndConfirm(tx, signers);
    return logs;
  }

  /** SeriesConfig status byte: 8 + 7*32 + 16 + 4 + 1 + 16 + 8*4 + 8 + 2 + 32. */
  async function configStatus(s: PublicKey): Promise<number> {
    const info = (await connection.getAccountInfo(s))!;
    return info.data[343];
  }

  before(async function () {
    this.timeout(120_000);
    const info = await connection.getAccountInfo(SERIES_ID);
    if (!info?.executable) {
      console.log("        series not deployed — run 'make pinocchio-series'");
      this.skip();
    }
    const oracleInfo = await connection.getAccountInfo(ORACLE_ID);
    if (!oracleInfo?.executable) {
      console.log("        oracle adapter not deployed — run 'make pinocchio-series'");
      this.skip();
    }

    // Fund the holder.
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: holder.publicKey,
          lamports: 30_000_000,
        }),
      ),
      [],
    );

    // A Token-2022 collateral mint with the scaledUiAmount extension at 1.0,
    // so the on-chain TLV walk runs for real.
    const mintKp = Keypair.generate();
    collateralMint = mintKp.publicKey;
    const mintLen = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: collateralMint,
          space: mintLen,
          lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeScaledUiAmountConfigInstruction(
          collateralMint, payer.publicKey, 1.0, TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMint2Instruction(
          collateralMint, 8, payer.publicKey, null, TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [mintKp],
    );
    holderCollateral = await createAssociatedTokenAccountIdempotent(
      connection, payer, collateralMint, holder.publicKey, undefined, TOKEN_2022_PROGRAM_ID,
    );
    await mintTo(
      connection, payer, collateralMint, holderCollateral, payer, 20 * ONE_TOKEN,
      [], undefined, TOKEN_2022_PROGRAM_ID,
    );

    // The fixture the validator loaded at genesis; its feed id is this run's.
    const src = await connection.getAccountInfo(PYTH_SOURCE);
    assert.isOk(src, "pyth fixture account missing — check make pinocchio-series");
    const data = src!.data;
    publishTime = Number(data.readBigInt64LE(8 + 32 + 1 + 32 + 8 + 8 + 4));
    const feedId = Buffer.from(data.subarray(8 + 32 + 1, 8 + 32 + 1 + 32));
    assert.isTrue(feedId.equals(FEED_ID), "fixture feed id mismatch");

    const [cfg] = PublicKey.findProgramAddressSync(
      [seed("feed-config"), FEED_ID], ORACLE_ID,
    );
    feedConfig = cfg;
    if (!(await connection.getAccountInfo(cfg))) {
      await oracleAdapter.methods
        .initializeFeedConfig(Array.from(FEED_ID), new BN(600), 13)
        .accounts({
          payer: payer.publicKey,
          admin: payer.publicKey,
          feedConfig: cfg,
          source: PYTH_SOURCE,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  it("creates a series with the Anchor byte layout", async function () {
    const now = Math.floor(Date.now() / 1000);
    const maturity = now + 25;
    assert.isBelow(maturity, publishTime, "fixture print must land after maturity");
    s = seriesPda(STRIKE, maturity);
    vault = vaultOf(s);
    pMint = pMintPda(s);
    nMint = nMintPda(s);

    const tx = await series.methods
      .createSeries({
        strike: new BN(STRIKE),
        maturityTs: new BN(maturity),
        priceDecimals: 8,
        settlementDelaySecs: new BN(0),
        maxOracleAgeSecs: new BN(600),
        maxPriceLagSecs: new BN(900),
        minSplitAmount: new BN(1_000),
        feeBps: 0,
      })
      .accounts({
        payer: payer.publicKey,
        factoryAuthority: payer.publicKey,
        admin: payer.publicKey,
        series: s,
        collateralMint,
        collateralVault: vault,
        oracleAdapter: feedConfig,
        pMint,
        nMint,
        feeRecipient: payer.publicKey,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    const logs = await sendForLogs(tx);

    const info = (await connection.getAccountInfo(s))!;
    assert.isTrue(info.owner.equals(SERIES_ID));
    assert.equal(info.data.length, 345, "8 + InitSpace");
    assert.equal(await configStatus(s), 0, "Open");
    // Strike lands at its documented offset, little-endian.
    const strikeBytes = Buffer.alloc(16);
    strikeBytes.writeBigInt64LE(BigInt(STRIKE) & BigInt("0xffffffffffffffff"));
    strikeBytes.writeBigInt64LE(BigInt(STRIKE) >> BigInt(64), 8);
    assert.isTrue(
      info.data.subarray(8 + 32 * 7, 8 + 32 * 7 + 16).equals(strikeBytes),
      "strike field present",
    );

    const created = findEvent(logs, eventDisc("SeriesCreated"));
    assert.isOk(created, "SeriesCreated emitted");
    assert.isTrue(created!.subarray(8, 40).equals(s.toBuffer()));

    // The vault is a real Token-2022 account owned by the series PDA.
    const vaultAcct = await getAccount(connection, vault, undefined, TOKEN_2022_PROGRAM_ID);
    assert.isTrue(vaultAcct.owner.equals(s), "vault authority is the series PDA");
    assert.isTrue(vaultAcct.mint.equals(collateralMint));
  });

  it("splits, then merges back half", async function () {
    receiverP = await createAssociatedTokenAccountIdempotent(
      connection, payer, pMint, holder.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    receiverN = await createAssociatedTokenAccountIdempotent(
      connection, payer, nMint, holder.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    // The burn sources are the same holder ATAs.
    const holderP = receiverP;
    const holderN = receiverN;

    const splitTx = await series.methods
      .split(new BN(2 * ONE_TOKEN))
      .accounts({
        holder: holder.publicKey,
        series: s,
        collateralMint,
        collateralVault: vault,
        holderCollateral,
        pMint,
        nMint,
        receiverP,
        receiverN,
        feeVault: null,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();
    const logs = await sendForLogs(splitTx, [holder]);
    assert.isOk(findEvent(logs, eventDisc("SplitExecuted")), "SplitExecuted emitted");
    assert.equal(await balance(receiverP, TOKEN_PROGRAM_ID), 2 * ONE_TOKEN);
    assert.equal(await balance(receiverN, TOKEN_PROGRAM_ID), 2 * ONE_TOKEN);
    assert.equal(await balance(vault), 2 * ONE_TOKEN);

    const mergeTx = await series.methods
      .merge(new BN(ONE_TOKEN / 2))
      .accounts({
        holder: holder.publicKey,
        series: s,
        collateralMint,
        collateralVault: vault,
        holderCollateral,
        pMint,
        nMint,
        holderP,
        holderN,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();
    await sendForLogs(mergeTx, [holder]);
    assert.equal(await balance(receiverP, TOKEN_PROGRAM_ID), (3 * ONE_TOKEN) / 2);
    assert.equal(await balance(vault), (3 * ONE_TOKEN) / 2);
  });

  it("pauses splits without trapping collateral", async function () {
    await series.methods
      .pauseSplits()
      .accounts({ admin: payer.publicKey, series: s })
      .rpc();
    assert.equal(await configStatus(s), 1, "Paused");

    let failed = false;
    try {
      await series.methods
        .split(new BN(1_000))
        .accounts({
          holder: holder.publicKey,
          series: s,
          collateralMint,
          collateralVault: vault,
          holderCollateral,
          pMint,
          nMint,
          receiverP,
          receiverN,
          feeVault: null,
          collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "split while paused must fail");

    // Merge still works while paused: a pause must never trap collateral.
    const holderP = await createAssociatedTokenAccountIdempotent(
      connection, payer, pMint, holder.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    const holderN = await createAssociatedTokenAccountIdempotent(
      connection, payer, nMint, holder.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    await series.methods
      .merge(new BN(1_000))
      .accounts({
        holder: holder.publicKey,
        series: s,
        collateralMint,
        collateralVault: vault,
        holderCollateral,
        pMint,
        nMint,
        holderP,
        holderN,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([holder])
      .rpc();

    await series.methods
      .unpauseSplits()
      .accounts({ admin: payer.publicKey, series: s })
      .rpc();
    assert.equal(await configStatus(s), 0, "Open again");
  });

  it("settles against the Pyth print after maturity", async function () {
    const now = Math.floor(Date.now() / 1000);
    if (now < publishTime + 1) await sleep((publishTime + 1 - now) * 1000);

    // Pools partition whatever the vault holds: 2e8 split, 0.5e8 + 1000
    // merged back, so 149,999,000 at five-sixths to P.
    const vaultBefore = await balance(vault);
    const pExpect = (BigInt(vaultBefore) * BigInt(500)) / BigInt(600);
    const nExpect = BigInt(vaultBefore) - pExpect;

    const settlement = settlementPda(s);
    const tx = await series.methods
      .settle()
      .accounts({
        payer: payer.publicKey,
        series: s,
        settlement,
        collateralMint,
        collateralVault: vault,
        pMint,
        nMint,
        oracleAdapter: feedConfig,
        priceSource: PYTH_SOURCE,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    const logs = await sendForLogs(tx);
    const settled = findEvent(logs, eventDisc("SeriesSettled"));
    assert.isOk(settled, "SeriesSettled emitted");
    const pPool = settled!.readBigUInt64LE(8 + 32 + 16 + 4 + 8 + 8);
    const nPool = settled!.readBigUInt64LE(8 + 32 + 16 + 4 + 8 + 8 + 8);
    assert.equal(pPool, pExpect);
    assert.equal(nPool, nExpect);
    assert.equal(await configStatus(s), 2, "Settled");

    let failed = false;
    try {
      await series.methods
        .settle()
        .accounts({
          payer: payer.publicKey,
          series: s,
          settlement: Keypair.generate().publicKey,
          collateralMint,
          collateralVault: vault,
          pMint,
          nMint,
          oracleAdapter: feedConfig,
          priceSource: PYTH_SOURCE,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "second settle must fail");
  });

  it("redeems both sides pro-rata and sweeps the dust", async function () {
    const settlement = settlementPda(s);
    for (const side of ["p", "n"] as const) {
      const bal = side === "p"
        ? await balance(receiverP, TOKEN_PROGRAM_ID)
        : await balance(receiverN, TOKEN_PROGRAM_ID);
      const tx = await (side === "p" ? series.methods.redeemP(new BN(bal)) : series.methods.redeemN(new BN(bal)))
        .accounts({
          holder: holder.publicKey,
          series: s,
          settlement,
          collateralMint,
          collateralVault: vault,
          holderCollateral,
          ...(side === "p" ? { pMint, holderP: receiverP } : { nMint, holderN: receiverN }),
          collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      const logs = await sendForLogs(tx, [holder]);
      assert.isOk(findEvent(logs, eventDisc("Redeemed")), `${side} Redeemed emitted`);
    }

    // Everything retired: both claim supplies are zero.
    assert.equal(await balance(receiverP, TOKEN_PROGRAM_ID), 0);
    assert.equal(await balance(receiverN, TOKEN_PROGRAM_ID), 0);

    // The dust recipient is a payer-owned collateral account, as sweep demands.
    const feeVault = await createAssociatedTokenAccountIdempotent(
      connection, payer, collateralMint, payer.publicKey, undefined, TOKEN_2022_PROGRAM_ID,
    );
    const sweepTx = await series.methods
      .sweepDust()
      .accounts({
        admin: payer.publicKey,
        series: s,
        collateralMint,
        collateralVault: vault,
        feeVault,
        pMint,
        nMint,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();
    const sweepLogs = await sendForLogs(sweepTx);
    assert.isOk(findEvent(sweepLogs, eventDisc("DustSwept")), "DustSwept emitted");
  });

  it("renounce kills the admin paths on a second series", async function () {
    const now = Math.floor(Date.now() / 1000);
    const s2 = seriesPda(STRIKE + 100 * USD, now + 3600);
    const vault2 = vaultOf(s2);
    await series.methods
      .createSeries({
        strike: new BN(STRIKE + 100 * USD),
        maturityTs: new BN(now + 3600),
        priceDecimals: 8,
        settlementDelaySecs: new BN(0),
        maxOracleAgeSecs: new BN(600),
        maxPriceLagSecs: new BN(900),
        minSplitAmount: new BN(1_000),
        feeBps: 0,
      })
      .accounts({
        payer: payer.publicKey,
        factoryAuthority: payer.publicKey,
        admin: payer.publicKey,
        series: s2,
        collateralMint,
        collateralVault: vault2,
        oracleAdapter: feedConfig,
        pMint: pMintPda(s2),
        nMint: nMintPda(s2),
        feeRecipient: payer.publicKey,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await series.methods
      .renounceAdmin()
      .accounts({ admin: payer.publicKey, series: s2 })
      .rpc();

    let failed = false;
    try {
      await series.methods
        .pauseSplits()
        .accounts({ admin: payer.publicKey, series: s2 })
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "pause after renounce must fail");
  });
});
