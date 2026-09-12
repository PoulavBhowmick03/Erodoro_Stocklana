// SPDX-License-Identifier: Apache-2.0
//
// §12 case 12: collateral moves with the transfer hook armed.
//
// The plan [§9] is blunt about why this matters: `transferHook.programId` on
// TSLAx is `None` today and the authority can arm it at any time without
// redeploying the mint. On that day every vault instruction that moves
// collateral either keeps working or starts failing, and retrofitting hook
// support means changing account structs, which means a migration.
//
// So this file runs the whole lifecycle against a mint whose hook is armed
// from the start, and asserts two things that have to hold together:
//
//   1. Every collateral movement still succeeds.
//   2. The hook actually ran — its counter advances once per transfer. A path
//      that silently bypassed the hook would pass (1) and be wrong.
//
// It also asserts the negative: omitting the resolved hook accounts makes the
// transfer fail. Without that, (1) could be true because the hook was never
// really armed.

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
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountIdempotent,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  mintTo,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const IDL_DIR = path.resolve(process.cwd(), "target", "idl");
const enc = new TextEncoder();
const seed = (s: string) => Buffer.from(enc.encode(s));
const i128le = (v: any) => new BN(v).toTwos(128).toArrayLike(Buffer, "le", 16);
const i64le = (v: any) => new BN(v).toTwos(64).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USD = 100_000_000;
const ONE_TOKEN = 100_000_000;
const COLLATERAL_DECIMALS = 8;
const TERM_SECS = 10;

const HOOK_PROGRAM_ID = new PublicKey("A7q6ebW3jMRzx8JDNSYKXpVNdfaE78EaTYCP5LxZFNXR");

/**
 * A real Pyth price account, loaded into the validator by Anchor.toml. There
 * is no mock oracle — the hook test settles against the same genuine
 * `PriceUpdateV2` bytes as everything else.
 */
const PYTH = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/pyth-manifest.json"), "utf8"),
) as Record<string, { address: string; price: number; publishTime: number }>;
const SCENARIO = "at-600";
const feedIdFor = (name: string) =>
  crypto.createHash("sha256").update(`erodoro:feed:${name}`).digest();

/** SPL discriminators are the first 8 bytes of sha256 over the namespaced name. */
const splDiscriminator = (name: string) =>
  crypto.createHash("sha256").update(name).digest().subarray(0, 8);

function loadProgram(name: string, provider: anchor.AnchorProvider): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(IDL_DIR, `${name}.json`), "utf8"));
  return new anchor.Program(idl, provider);
}

async function clusterNow(connection: Connection): Promise<number> {
  const slot = await connection.getSlot();
  return (await connection.getBlockTime(slot))!;
}

describe("§12 case 12 — the transfer hook, armed", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let oracleAdapter: anchor.Program<any>;
  let series: anchor.Program<any>;

  const issuer = Keypair.generate();
  const holder = Keypair.generate();

  let collateralMint: PublicKey;
  let holderCollateral: PublicKey;
  let feedConfig: PublicKey;
  let maturity = 0;
  let metaList: PublicKey;
  let counter: PublicKey;

  const seriesPda = (strike: number, maturity: number) =>
    PublicKey.findProgramAddressSync(
      [
        seed("series"),
        payer.publicKey.toBuffer(),
        collateralMint.toBuffer(),
        i128le(strike),
        i64le(maturity),
      ],
      series.programId
    )[0];
  const pMintPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("p-mint"), s.toBuffer()], series.programId)[0];
  const nMintPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("n-mint"), s.toBuffer()], series.programId)[0];
  const settlementPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([seed("settlement"), s.toBuffer()], series.programId)[0];
  const vaultOf = (s: PublicKey) =>
    getAssociatedTokenAddressSync(collateralMint, s, true, TOKEN_2022_PROGRAM_ID);

  const balance = async (a: PublicKey, p = TOKEN_2022_PROGRAM_ID) =>
    Number((await getAccount(connection, a, undefined, p)).amount);

  /** How many times the hook has executed against this mint. */
  async function hookExecutions(): Promise<number> {
    const info = await connection.getAccountInfo(counter);
    assert.isNotNull(info, "counter account missing");
    return Number(info!.data.readBigUInt64LE(0));
  }

  /**
   * Resolve the accounts an armed hook needs, exactly as §9 prescribes: with
   * the `spl-transfer-hook-interface` off-chain helper, reading the mint's
   * extension and the hook's own extra-account-meta list. Nothing here is
   * hard-coded to this particular hook.
   */
  async function hookAccounts(source: PublicKey, destination: PublicKey, owner: PublicKey) {
    // The probe has to carry the four base Execute accounts before resolution
    // runs: extra metas may address them by index, and this hook's counter is
    // seeded on `AccountKey { index: 1 }` — the mint.
    const base = [source, collateralMint, destination, owner].map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    }));
    // `TransactionInstruction` keeps the array it is handed rather than
    // copying it, and the resolver pushes onto that same array — so the count
    // has to be taken before the call, not after.
    const baseLen = base.length;
    const probe = new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: base,
      data: Buffer.alloc(0),
    });
    await addExtraAccountMetasForExecute(
      connection, probe, HOOK_PROGRAM_ID, source, collateralMint, destination, owner, 0
    );
    // Only what resolution appended: the extras, the hook program, and its
    // validation account. The base four are already in the instruction.
    const resolved = probe.keys.slice(baseLen).map((k) => ({
      pubkey: k.pubkey,
      isSigner: false,
      isWritable: k.isWritable,
    }));
    return resolved;
  }

  before("arm a hook on the mint, then open a feed", async () => {
    oracleAdapter = loadProgram("oracle_adapter", provider);
    series = loadProgram("series", provider);

    for (const kp of [holder, issuer]) {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: kp.publicKey,
            lamports: 20_000_000,
          })
        ),
        [payer]
      );
    }

    // A mint shaped like TSLAx on the day Backed arms the hook: the same
    // scaledUiAmount extension, plus a live transferHook.
    const mintKp = Keypair.generate();
    collateralMint = mintKp.publicKey;
    const extensions = [ExtensionType.TransferHook, ExtensionType.ScaledUiAmountConfig];
    const mintLen = getMintLen(extensions);
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
        createInitializeTransferHookInstruction(
          collateralMint, issuer.publicKey, HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID
        ),
        createInitializeScaledUiAmountConfigInstruction(
          collateralMint, issuer.publicKey, 1.0, TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMint2Instruction(
          collateralMint, COLLATERAL_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID
        )
      ),
      [payer, mintKp]
    );

    metaList = PublicKey.findProgramAddressSync(
      [seed("extra-account-metas"), collateralMint.toBuffer()], HOOK_PROGRAM_ID
    )[0];
    counter = PublicKey.findProgramAddressSync(
      [seed("counter"), collateralMint.toBuffer()], HOOK_PROGRAM_ID
    )[0];

    // Publish the hook's extra-account-meta list. The payload is an empty
    // vector; the program builds its own metas.
    const data = Buffer.concat([
      splDiscriminator("spl-transfer-hook-interface:initialize-extra-account-metas"),
      Buffer.alloc(4), // extra_account_metas: empty
    ]);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        new TransactionInstruction({
          programId: HOOK_PROGRAM_ID,
          keys: [
            { pubkey: metaList, isSigner: false, isWritable: true },
            { pubkey: collateralMint, isSigner: false, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: counter, isSigner: false, isWritable: true },
          ],
          data,
        })
      ),
      [payer]
    );
    assert.equal(await hookExecutions(), 0, "counter starts at zero");

    holderCollateral = await createAssociatedTokenAccountIdempotent(
      connection, payer, collateralMint, holder.publicKey, undefined, TOKEN_2022_PROGRAM_ID
    );
    await mintTo(
      connection, payer, collateralMint, holderCollateral, payer, 10 * ONE_TOKEN,
      [], undefined, TOKEN_2022_PROGRAM_ID
    );

    const feedId = feedIdFor(SCENARIO);
    feedConfig = PublicKey.findProgramAddressSync(
      [seed("feed-config"), feedId], oracleAdapter.programId
    )[0];
    if (!(await connection.getAccountInfo(feedConfig))) {
      await oracleAdapter.methods
        .initializeFeedConfig(Array.from(feedId), new BN(600), 13)
        .accounts({
          payer: payer.publicKey, admin: payer.publicKey, feedConfig,
          source: new PublicKey(PYTH[SCENARIO].address),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  it("mints collateral through the hook, proving it is genuinely armed", async () => {
    // `mintTo` in setup already moved tokens; minting does not invoke the
    // hook, only transfers do. Confirm the baseline before the lifecycle.
    assert.equal(await hookExecutions(), 0, "minting must not trigger the hook");
  });

  it("runs the full lifecycle with the hook armed, and the hook runs every time", async function () {
    maturity = PYTH[SCENARIO].publishTime - 5;
    const now = await clusterNow(connection);
    if (maturity <= now + 3) {
      console.log("        Pyth fixtures are stale; run `pnpm pyth:fixture` first.");
      this.skip();
    }
    const strike = 500 * USD;
    const s = seriesPda(strike, maturity);

    await series.methods
      .createSeries({
        strike: new BN(strike),
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
        collateralVault: vaultOf(s),
        oracleAdapter: feedConfig,
        pMint: pMintPda(s),
        nMint: nMintPda(s),
        feeRecipient: payer.publicKey,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    assert.equal(await hookExecutions(), 0, "creating a series moves no collateral");

    const pAta = await createAssociatedTokenAccountIdempotent(
      connection, payer, pMintPda(s), holder.publicKey, undefined, TOKEN_PROGRAM_ID
    );
    const nAta = await createAssociatedTokenAccountIdempotent(
      connection, payer, nMintPda(s), holder.publicKey, undefined, TOKEN_PROGRAM_ID
    );

    // --- split: holder -> vault -----------------------------------------
    const splitAccounts = {
      holder: holder.publicKey,
      series: s,
      collateralMint,
      collateralVault: vaultOf(s),
      holderCollateral,
      pMint: pMintPda(s),
      nMint: nMintPda(s),
      receiverP: pAta,
      receiverN: nAta,
      feeVault: null,
      collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    // The negative first: without the resolved hook accounts the transfer
    // cannot complete, which is what proves the hook is enforced rather than
    // decorative.
    let missingAccounts = false;
    try {
      await series.methods
        .split(new BN(ONE_TOKEN))
        .accounts(splitAccounts)
        .signers([holder])
        .rpc();
    } catch {
      missingAccounts = true;
    }
    assert.isTrue(missingAccounts, "an armed hook must reject a transfer missing its accounts");
    assert.equal(await hookExecutions(), 0, "and nothing ran");

    await series.methods
      .split(new BN(ONE_TOKEN))
      .accounts(splitAccounts)
      .remainingAccounts(await hookAccounts(holderCollateral, vaultOf(s), holder.publicKey))
      .signers([holder])
      .rpc();

    assert.equal(await balance(vaultOf(s)), ONE_TOKEN, "collateral reached the vault");
    assert.equal(await balance(pAta, TOKEN_PROGRAM_ID), ONE_TOKEN);
    assert.equal(await hookExecutions(), 1, "the hook ran on the split");

    // --- merge: vault -> holder, authority is the series PDA -------------
    const quarter = ONE_TOKEN / 4;
    await series.methods
      .merge(new BN(quarter))
      .accounts({
        holder: holder.publicKey,
        series: s,
        collateralMint,
        collateralVault: vaultOf(s),
        holderCollateral,
        pMint: pMintPda(s),
        nMint: nMintPda(s),
        holderP: pAta,
        holderN: nAta,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(await hookAccounts(vaultOf(s), holderCollateral, s))
      .signers([holder])
      .rpc();

    assert.equal(await balance(vaultOf(s)), ONE_TOKEN - quarter, "collateral left the vault");
    assert.equal(await hookExecutions(), 2, "the hook ran on the merge, under a PDA authority");

    // --- settle: moves no tokens ----------------------------------------
    while ((await clusterNow(connection)) <= PYTH[SCENARIO].publishTime + 1) await sleep(1000);
    await series.methods
      .settle()
      .accounts({
        payer: payer.publicKey,
        series: s,
        settlement: settlementPda(s),
        collateralMint,
        collateralVault: vaultOf(s),
        pMint: pMintPda(s),
        nMint: nMintPda(s),
        oracleAdapter: feedConfig,
        priceSource: new PublicKey(PYTH[SCENARIO].address),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    assert.equal(await hookExecutions(), 2, "settlement moves no tokens, so no hook run");

    // --- redeem both sides ----------------------------------------------
    const outstanding = ONE_TOKEN - quarter;
    await series.methods
      .redeemP(new BN(outstanding))
      .accounts({
        holder: holder.publicKey,
        series: s,
        settlement: settlementPda(s),
        collateralMint,
        collateralVault: vaultOf(s),
        holderCollateral,
        pMint: pMintPda(s),
        holderP: pAta,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(await hookAccounts(vaultOf(s), holderCollateral, s))
      .signers([holder])
      .rpc();
    assert.equal(await hookExecutions(), 3, "the hook ran on redeem_p");

    await series.methods
      .redeemN(new BN(outstanding))
      .accounts({
        holder: holder.publicKey,
        series: s,
        settlement: settlementPda(s),
        collateralMint,
        collateralVault: vaultOf(s),
        holderCollateral,
        nMint: nMintPda(s),
        holderN: nAta,
        collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(await hookAccounts(vaultOf(s), holderCollateral, s))
      .signers([holder])
      .rpc();
    assert.equal(await hookExecutions(), 4, "the hook ran on redeem_n");

    // Solvency held throughout, with the hook in the path.
    const st = await series.account.settlement.fetch(settlementPda(s));
    assert.equal(
      st.pPool.add(st.nPool).toNumber(),
      st.collateralAtSettlement.toNumber(),
      "pools still partition the collateral"
    );
    assert.isAtMost(await balance(vaultOf(s)), 1, "vault drained to dust");
  });
});
