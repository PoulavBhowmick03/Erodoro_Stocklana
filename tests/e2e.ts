// SPDX-License-Identifier: Apache-2.0
//
// End-to-end lifecycle on a validator, against Pyth account-layout fixtures.
//
// There is no mock-oracle program. Every settlement below reads bytes derived
// from a genuine `PriceUpdateV2` account and loaded under the Pyth receiver
// owner by Anchor.toml. Price, feed id, and publish time are rewritten per
// scenario, which invalidates the original attestation. The suite exercises
// decoding, owner/feed checks, the recorded verification-level floor, and
// exponent conversion. It does not prove Pyth receiver signature verification.
//
// # Why the suite is shaped like this
//
// A snapshot has a fixed publish time `T`. Settlement needs a quote at or
// after the maturity, and creating a series needs that maturity to be in the
// future — so every series must be **created before T and settled after it**.
// Hence one setup phase that opens every series, a single wait, and then tests
// that only settle and assert.
//
//   pnpm pyth:fixture && anchor test --skip-build

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";

const BN = (anchor as any).BN ?? (anchor as any).default.BN;
const { assert } = chai;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  burn,
  createAssociatedTokenAccountIdempotent,
  createInitializeMint2Instruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createUpdateMultiplierDataInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
  transferChecked,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const COLLATERAL_DECIMALS = 8;
const USD = 100_000_000;
const ONE_TOKEN = 100_000_000;

const IDL_DIR = path.resolve(process.cwd(), "target", "idl");
const PYTH = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/pyth-manifest.json"), "utf8"),
) as Record<string, { address: string; price: number; publishTime: number }>;

const feedIdFor = (name: string) =>
  crypto.createHash("sha256").update(`erodoro:feed:${name}`).digest();

const enc = new TextEncoder();
const seed = (s: string) => Buffer.from(enc.encode(s));
const i128le = (v: any) => new BN(v).toTwos(128).toArrayLike(Buffer, "le", 16);
const i64le = (v: any) => new BN(v).toTwos(64).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadProgram(name: string, provider: anchor.AnchorProvider): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(IDL_DIR, `${name}.json`), "utf8"));
  return new anchor.Program(idl, provider);
}

async function clusterNow(connection: Connection): Promise<number> {
  const slot = await connection.getSlot();
  return (await connection.getBlockTime(slot))!;
}

describe("covered calls, end to end against Pyth account-layout fixtures", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let oracleAdapter: anchor.Program<any>;
  let series: anchor.Program<any>;
  let factory: anchor.Program<any>;

  /** Stands in for the issuer: holds the multiplier authority and the delegate. */
  const issuer = Keypair.generate();
  const holder = Keypair.generate();
  const second = Keypair.generate();

  let collateralMint: PublicKey;
  let holderCollateral: PublicKey;
  let secondCollateral: PublicKey;
  let issuerCollateral: PublicKey;

  /** One opened series per scenario, all created before the fixtures' publish time. */
  const opened = new Map<string, any>();
  let settleAfter = 0;

  const seriesPda = (strike: number, maturity: number, creator = payer.publicKey) =>
    PublicKey.findProgramAddressSync(
      [seed("series"), creator.toBuffer(), collateralMint.toBuffer(), i128le(strike), i64le(maturity)],
      series.programId,
    )[0];
  const pMintPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("p-mint"), s.toBuffer()], series.programId)[0];
  const nMintPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("n-mint"), s.toBuffer()], series.programId)[0];
  const settlementPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("settlement"), s.toBuffer()], series.programId)[0];
  const vaultOf = (s: PublicKey) =>
    getAssociatedTokenAddressSync(collateralMint, s, true, TOKEN_2022_PROGRAM_ID);
  const feedConfigPda = (feedId: Buffer) =>
    PublicKey.findProgramAddressSync([seed("feed-config"), feedId], oracleAdapter.programId)[0];

  const balance = async (a: PublicKey, p = TOKEN_2022_PROGRAM_ID) =>
    Number((await getAccount(connection, a, undefined, p)).amount);

  /** A feed config pinned to one fixture's identity. */
  async function feedFor(scenario: string) {
    const feedId = feedIdFor(scenario);
    const cfg = feedConfigPda(feedId);
    if (!(await connection.getAccountInfo(cfg))) {
      await oracleAdapter.methods
        // 600s staleness tolerance; 13 guardian signatures, which the real
        // account's `Full` verification level clears.
        .initializeFeedConfig(Array.from(feedId), new BN(600), 13)
        .accounts({
          payer: payer.publicKey,
          admin: payer.publicKey,
          feedConfig: cfg,
          source: new PublicKey(PYTH[scenario].address),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    return cfg;
  }

  async function openSeries(scenario: string, strikeUsd: number, maturity: number, lag = 900) {
    const s = seriesPda(strikeUsd, maturity);
    await series.methods
      .createSeries({
        strike: new BN(strikeUsd),
        maturityTs: new BN(maturity),
        priceDecimals: 8,
        settlementDelaySecs: new BN(0),
        maxOracleAgeSecs: new BN(600),
        maxPriceLagSecs: new BN(lag),
        minSplitAmount: new BN(1_000),
        feeBps: 0,
      })
      .accounts({
        payer: payer.publicKey,
        factoryAuthority: payer.publicKey,
        admin: payer.publicKey,
        series: s,
        collateralMint,
        collateralVault: vaultOf(s),
        oracleAdapter: await feedFor(scenario),
        pMint: pMintPda(s),
        nMint: nMintPda(s),
        feeRecipient: payer.publicKey,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return s;
  }

  async function split(s: PublicKey, who: Keypair, whoCollateral: PublicKey, amount: number) {
    const pAta = await createAssociatedTokenAccountIdempotent(
      connection, payer, pMintPda(s), who.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    const nAta = await createAssociatedTokenAccountIdempotent(
      connection, payer, nMintPda(s), who.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    await series.methods
      .split(new BN(amount))
      .accounts({
        holder: who.publicKey,
        series: s,
        collateralMint,
        collateralVault: vaultOf(s),
        holderCollateral: whoCollateral,
        pMint: pMintPda(s),
        nMint: nMintPda(s),
        receiverP: pAta,
        receiverN: nAta,
        feeVault: null,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who])
      .rpc();
    return { pAta, nAta };
  }

  async function settle(scenario: string) {
    const o = opened.get(scenario)!;
    await series.methods
      .settle()
      .accounts({
        payer: payer.publicKey,
        series: o.series,
        settlement: settlementPda(o.series),
        collateralMint,
        collateralVault: vaultOf(o.series),
        pMint: pMintPda(o.series),
        nMint: nMintPda(o.series),
        oracleAdapter: await feedFor(scenario),
        priceSource: new PublicKey(PYTH[scenario].address),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return series.account.settlement.fetch(settlementPda(o.series));
  }

  async function redeem(
    side: "p" | "n",
    s: PublicKey,
    who: Keypair,
    whoCollateral: PublicKey,
    claimAta: PublicKey,
    amount: number,
  ) {
    const before = await balance(whoCollateral);
    const common = {
      holder: who.publicKey,
      series: s,
      settlement: settlementPda(s),
      collateralMint,
      collateralVault: vaultOf(s),
      holderCollateral: whoCollateral,
      collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    if (side === "p") {
      await series.methods
        .redeemP(new BN(amount))
        .accounts({ ...common, pMint: pMintPda(s), holderP: claimAta })
        .signers([who])
        .rpc();
    } else {
      await series.methods
        .redeemN(new BN(amount))
        .accounts({ ...common, nMint: nMintPda(s), holderN: claimAta })
        .signers([who])
        .rpc();
    }
    return (await balance(whoCollateral)) - before;
  }

  async function setMultiplier(multiplier: number, effectiveTs: number) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createUpdateMultiplierDataInstruction(
          collateralMint,
          issuer.publicKey,
          multiplier,
          BigInt(effectiveTs),
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer, issuer],
    );
  }

  // --- setup: everything must be created before the fixtures' publish time ---

  before("open every series before the Pyth snapshots' publish time", async function () {
    oracleAdapter = loadProgram("oracle_adapter", provider);
    series = loadProgram("series", provider);
    factory = loadProgram("factory", provider);

    const now = await clusterNow(connection);
    const T = PYTH["at-600"].publishTime;
    if (T <= now + 15) {
      console.log(
        `        Pyth fixtures are stale (publish ${T}, now ${now}). Run \`pnpm pyth:fixture\` first.`,
      );
      this.skip();
    }
    settleAfter = T;

    for (const kp of [holder, second, issuer]) {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: kp.publicKey,
            lamports: 30_000_000,
          }),
        ),
        [payer],
      );
    }

    // A mint shaped like a real tokenized equity: Token-2022, 8 decimals, with
    // the two extensions that bear on this design.
    const mintKp = Keypair.generate();
    collateralMint = mintKp.publicKey;
    const mintLen = getMintLen([
      ExtensionType.ScaledUiAmountConfig,
      ExtensionType.PermanentDelegate,
    ]);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: collateralMint,
          space: mintLen,
          lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeScaledUiAmountConfigInstruction(
          collateralMint, issuer.publicKey, 1.0, TOKEN_2022_PROGRAM_ID,
        ),
        createInitializePermanentDelegateInstruction(
          collateralMint, issuer.publicKey, TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMint2Instruction(
          collateralMint, COLLATERAL_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer, mintKp],
    );

    for (const [kp, set] of [
      [holder, (v: PublicKey) => (holderCollateral = v)],
      [second, (v: PublicKey) => (secondCollateral = v)],
      [issuer, (v: PublicKey) => (issuerCollateral = v)],
    ] as const) {
      const ata = await createAssociatedTokenAccountIdempotent(
        connection, payer, collateralMint, kp.publicKey, undefined, TOKEN_2022_PROGRAM_ID,
      );
      set(ata);
      await mintTo(
        connection, payer, collateralMint, ata, payer, 20 * ONE_TOKEN,
        [], undefined, TOKEN_2022_PROGRAM_ID,
      );
    }

    // Every series matures a little before the snapshots' publish time, so the
    // quote is at-or-after maturity when it is finally settled. Each gets its
    // own maturity: the series PDA is seeded on
    // (creator, mint, strike, maturity), so identical parameters would name
    // one address and the second creation would collide.
    const scenarios = ["at-250", "at-600", "at-300", "at-1000", "stale", "at-1200"];
    for (const [i, scenario] of scenarios.entries()) {
      const maturity = T - 5 - i;
      const s = await openSeries(scenario, 500 * USD, maturity);
      const atas = await split(s, holder, holderCollateral, ONE_TOKEN);
      opened.set(scenario, { series: s, ...atas, maturity });
    }

    // The drain scenario needs a second holder in the same series.
    const drain = opened.get("at-1000")!;
    drain.second = await split(drain.series, second, secondCollateral, ONE_TOKEN);
  });

  it("splits collateral into P and N", async () => {
    const o = opened.get("at-600")!;
    assert.equal(await balance(vaultOf(o.series)), ONE_TOKEN, "vault holds the deposit");
    assert.equal(await balance(o.pAta, TOKEN_PROGRAM_ID), ONE_TOKEN, "P minted 1:1");
    assert.equal(await balance(o.nAta, TOKEN_PROGRAM_ID), ONE_TOKEN, "N minted 1:1");
  });

  it("waits for the Pyth snapshots to become settleable", async () => {
    // A quote from the future is rejected, correctly, so nothing can settle
    // until the cluster clock passes the snapshots' publish time.
    while ((await clusterNow(connection)) <= settleAfter + 1) await sleep(1000);
    assert.isAbove(await clusterNow(connection), settleAfter);
  });

  it("settles below the strike: P takes everything, N expires worthless", async () => {
    const st = await settle("at-250");
    const o = opened.get("at-250")!;
    assert.equal(st.price.toString(), String(PYTH["at-250"].price), "settled on the Pyth price");
    assert.equal(st.pPool.toNumber(), ONE_TOKEN);
    assert.equal(st.nPool.toNumber(), 0, "N is worthless below the strike");

    assert.equal(await redeem("p", o.series, holder, holderCollateral, o.pAta, ONE_TOKEN), ONE_TOKEN);
    assert.equal(await redeem("n", o.series, holder, holderCollateral, o.nAta, ONE_TOKEN), 0);
  });

  it("settles above the strike: the cap holds and N keeps the excess", async () => {
    const st = await settle("at-600");
    const o = opened.get("at-600")!;
    const expectedP = Math.floor((ONE_TOKEN * 500) / 600);
    assert.equal(st.pPool.toNumber(), expectedP, "P is capped at the strike");
    assert.equal(st.pPool.add(st.nPool).toNumber(), ONE_TOKEN, "pools partition the vault");

    const paidP = await redeem("p", o.series, holder, holderCollateral, o.pAta, ONE_TOKEN);
    const paidN = await redeem("n", o.series, holder, holderCollateral, o.nAta, ONE_TOKEN);
    assert.equal(paidP + paidN, ONE_TOKEN, "nothing is created or destroyed");
  });

  it("§6: a 2-for-1 split mid-series leaves both sides economically unchanged", async () => {
    // The headline risk. at-300 is the post-split price; without the strike
    // adjustment it falls under the $500 strike and wipes out N.
    const o = opened.get("at-300")!;
    const cfg = await series.account.seriesConfig.fetch(o.series);
    assert.equal(cfg.multiplierAtCreation.toString(), "1000000000000", "captured at 1.0");

    await setMultiplier(2.0, (await clusterNow(connection)) - 1);
    const st = await settle("at-300");

    assert.equal(st.multiplierAtSettlement.toString(), "2000000000000");
    assert.equal(st.effectiveStrike.toNumber(), 250 * USD, "the strike halved with the split");

    const expectedP = Math.floor((ONE_TOKEN * 500) / 600);
    assert.equal(st.pPool.toNumber(), expectedP, "P unchanged by a pure split");
    assert.isAbove(st.nPool.toNumber(), 0, "N survives the split");

    const paidP = await redeem("p", o.series, holder, holderCollateral, o.pAta, ONE_TOKEN);
    const paidN = await redeem("n", o.series, holder, holderCollateral, o.nAta, ONE_TOKEN);
    assert.equal(paidP + paidN, ONE_TOKEN);

    await setMultiplier(1.0, (await clusterNow(connection)) - 1);
  });

  it("§7: a permanent-delegate drain haircuts every redeemer equally", async () => {
    const o = opened.get("at-1000")!;
    const st = await settle("at-1000");
    assert.equal(st.pPool.add(st.nPool).toNumber(), 2 * ONE_TOKEN);

    const vaultBefore = await balance(vaultOf(o.series));
    const stolen = Math.floor(vaultBefore / 2);
    await transferChecked(
      connection, payer, vaultOf(o.series), collateralMint, issuerCollateral,
      issuer, stolen, COLLATERAL_DECIMALS, [], undefined, TOKEN_2022_PROGRAM_ID,
    );

    const paid = {
      holderP: await redeem("p", o.series, holder, holderCollateral, o.pAta, ONE_TOKEN),
      secondP: await redeem("p", o.series, second, secondCollateral, o.second.pAta, ONE_TOKEN),
      secondN: await redeem("n", o.series, second, secondCollateral, o.second.nAta, ONE_TOKEN),
      holderN: await redeem("n", o.series, holder, holderCollateral, o.nAta, ONE_TOKEN),
    };

    assert.closeTo(paid.holderP, paid.secondP, 2, "P redeemers took the same haircut");
    assert.closeTo(paid.holderN, paid.secondN, 2, "N redeemers took the same haircut");
    const total = Object.values(paid).reduce((a, b) => a + b, 0);
    assert.isAtMost(total, vaultBefore - stolen, "never paid out more than the vault held");

    const after = await series.account.settlement.fetch(settlementPda(o.series));
    assert.isTrue(after.shortfallObserved, "the drain is flagged on-chain");
  });

  it("cannot be stranded by burning a claim token outside the protocol", async () => {
    const o = opened.get("at-1200")!;
    await burn(connection, payer, o.pAta, pMintPda(o.series), holder, 1, [], undefined, TOKEN_PROGRAM_ID);

    const st = await settle("at-1200");
    assert.isTrue(st.supplyMismatch, "the mismatch is recorded, not rejected");
    assert.equal(st.pPool.add(st.nPool).toNumber(), st.collateralAtSettlement.toNumber());

    const paidP = await redeem("p", o.series, holder, holderCollateral, o.pAta, ONE_TOKEN - 1);
    assert.equal(paidP, st.pPool.toNumber(), "remaining P holders split the whole pool");
  });

  it("rejects a print from outside the settlement window", async () => {
    // The `stale` fixture's publish time is a day in the past — real Pyth
    // bytes, an impossible print for this series.
    try {
      await settle("stale");
      assert.fail("a quote outside the window must not settle a series");
    } catch (e) {
      assert.match(String(e), /OraclePriceStale|MarketClosed|stale|window|6016|6017/i);
    }
  });

  it("refuses to settle the same series twice", async () => {
    try {
      await settle("at-600");
      assert.fail("settlement is callable exactly once");
    } catch (e) {
      assert.match(String(e), /AlreadySettled|already|in use/i);
    }
  });

  it("the factory enforces policy, allowlists, and registers the series", async () => {
    const factoryPda = PublicKey.findProgramAddressSync([seed("factory")], factory.programId)[0];
    if (!(await connection.getAccountInfo(factoryPda))) {
      await factory.methods
        .initialize()
        .accounts({
          payer: payer.publicKey, admin: payer.publicKey, factory: factoryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const feedConfig = await feedFor("at-600");
    const oracleApproval = PublicKey.findProgramAddressSync(
      [seed("approved-oracle"), feedConfig.toBuffer()], factory.programId)[0];
    const collateralApproval = PublicKey.findProgramAddressSync(
      [seed("approved-collateral"), collateralMint.toBuffer()], factory.programId)[0];

    if (!(await connection.getAccountInfo(oracleApproval))) {
      await factory.methods.approveOracle().accounts({
        payer: payer.publicKey, admin: payer.publicKey, factory: factoryPda,
        feedConfig, approval: oracleApproval, systemProgram: SystemProgram.programId,
      }).rpc();
    }
    if (!(await connection.getAccountInfo(collateralApproval))) {
      await factory.methods.approveCollateral().accounts({
        payer: payer.publicKey, admin: payer.publicKey, factory: factoryPda,
        collateralMint, approval: collateralApproval, systemProgram: SystemProgram.programId,
      }).rpc();
    }

    const maturity = (await clusterNow(connection)) + 7 * 86400;
    const strike = 750 * USD;
    const s = seriesPda(strike, maturity, factoryPda);
    const record = PublicKey.findProgramAddressSync(
      [seed("record"), s.toBuffer()], factory.programId)[0];

    const params = {
      strike: new BN(strike), maturityTs: new BN(maturity), priceDecimals: 8,
      settlementDelaySecs: new BN(0), maxOracleAgeSecs: new BN(600),
      maxPriceLagSecs: new BN(900), minSplitAmount: new BN(1_000), feeBps: 0,
    };
    const accounts = {
      payer: payer.publicKey, admin: payer.publicKey, factory: factoryPda,
      seriesAdmin: payer.publicKey, oracleApproval, collateralApproval, feedConfig,
      collateralMint, series: s, collateralVault: vaultOf(s),
      pMint: pMintPda(s), nMint: nMintPda(s), feeRecipient: payer.publicKey, record,
      seriesProgram: series.programId, collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    let tooShort = false;
    try {
      const soon = (await clusterNow(connection)) + 60;
      await factory.methods
        .createSeries({ ...params, maturityTs: new BN(soon) })
        .accounts({ ...accounts, series: seriesPda(strike, soon, factoryPda) })
        .rpc();
    } catch {
      tooShort = true;
    }
    assert.isTrue(tooShort, "factory rejects a term below its floor");

    await factory.methods.createSeries(params).accounts(accounts).rpc();
    const rec = await factory.account.seriesRecord.fetch(record);
    assert.equal(rec.series.toBase58(), s.toBase58(), "registered the series it created");

    const cfg = await series.account.seriesConfig.fetch(s);
    assert.equal(cfg.factory.toBase58(), factoryPda.toBase58());
    assert.equal(cfg.collateralDecimals, COLLATERAL_DECIMALS, "decimals read off the mint");
  });

  it("blocks splits when paused, but never blocks merges", async () => {
    const maturity = (await clusterNow(connection)) + 3600;
    const s = await openSeries("live", 900 * USD, maturity);
    const { pAta, nAta } = await split(s, holder, holderCollateral, ONE_TOKEN);

    await series.methods.pauseSplits().accounts({ admin: payer.publicKey, series: s }).rpc();

    let blocked = false;
    try {
      await split(s, holder, holderCollateral, ONE_TOKEN);
    } catch {
      blocked = true;
    }
    assert.isTrue(blocked, "splits are blocked while paused");

    // A pause must never trap collateral behind existing claims.
    const before = await balance(holderCollateral);
    await series.methods
      .merge(new BN(ONE_TOKEN))
      .accounts({
        holder: holder.publicKey, series: s, collateralMint, collateralVault: vaultOf(s),
        holderCollateral, pMint: pMintPda(s), nMint: nMintPda(s), holderP: pAta, holderN: nAta,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([holder])
      .rpc();
    assert.equal(await balance(holderCollateral), before + ONE_TOKEN, "merge still works");
  });
});
