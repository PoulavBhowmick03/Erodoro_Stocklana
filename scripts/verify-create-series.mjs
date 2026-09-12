// SPDX-License-Identifier: Apache-2.0
//
// Drive the whole create path the UI drives, against live devnet.
//
// Mirrors `web/components/create-panel.tsx` step for step — factory, feed
// config, both approvals, then `create_series` through the factory CPI — using
// the same accounts and the same parameters. It exists because the panel's
// buttons cannot be clicked from here, and a green `next build` says nothing
// about whether these transactions land.
//
//   node scripts/verify-create-series.mjs
//
// Idempotent: every step checks for its account first, so re-running is free.
// Prints the series address and the P/N mints for the book verifier.

import anchor from "@coral-xyz/anchor";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";

// The sponsored devnet Pyth SOL/USD account, same as create-panel.tsx.
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const SOL_USD_FEED_ID = Uint8Array.from(
  Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex"),
);

const seed = (s) => Buffer.from(s, "utf8");
const i128le = (v) => v.toArrayLike(Buffer, "le", 16);
const i64le = (v) => v.toArrayLike(Buffer, "le", 8);

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });

  const factoryIdl = JSON.parse(fs.readFileSync("target/idl/factory.json", "utf8"));
  const seriesIdl = JSON.parse(fs.readFileSync("target/idl/series.json", "utf8"));
  const oracleIdl = JSON.parse(fs.readFileSync("target/idl/oracle_adapter.json", "utf8"));
  const factory = new Program(factoryIdl, provider);
  const series = new Program(seriesIdl, provider);
  const oracle = new Program(oracleIdl, provider);

  const factoryPda = PublicKey.findProgramAddressSync([seed("factory")], factory.programId)[0];
  const feedConfig = PublicKey.findProgramAddressSync(
    [seed("feed-config"), Buffer.from(SOL_USD_FEED_ID)],
    oracle.programId,
  )[0];
  const approvedOracle = PublicKey.findProgramAddressSync(
    [seed("approved-oracle"), feedConfig.toBuffer()],
    factory.programId,
  )[0];

  const exists = async (pk) => Boolean(await connection.getAccountInfo(pk));

  // --- 01 factory --------------------------------------------------------
  if (await exists(factoryPda)) {
    console.log("01 factory      already initialized", factoryPda.toBase58());
  } else {
    await factory.methods
      .initialize()
      .accounts({
        payer: kp.publicKey,
        admin: kp.publicKey,
        factory: factoryPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("01 factory      initialized", factoryPda.toBase58());
  }

  // --- 02 feed config ----------------------------------------------------
  // 13 signatures, not 0: the program now refuses a zero verification floor.
  if (await exists(feedConfig)) {
    console.log("02 feed config  already exists", feedConfig.toBase58());
  } else {
    await oracle.methods
      .initializeFeedConfig(Array.from(SOL_USD_FEED_ID), new BN(120), 13)
      .accounts({
        payer: kp.publicKey,
        admin: kp.publicKey,
        feedConfig,
        source: PYTH_SOL_USD,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("02 feed config  created", feedConfig.toBase58());
  }

  // --- 03 approve the feed ----------------------------------------------
  if (await exists(approvedOracle)) {
    console.log("03 feed approval already exists");
  } else {
    await factory.methods
      .approveOracle()
      .accounts({
        payer: kp.publicKey,
        admin: kp.publicKey,
        factory: factoryPda,
        feedConfig,
        approval: approvedOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("03 feed approval created");
  }

  // --- collateral mint (Token-2022, plain) -------------------------------
  // A fresh mint per run keeps the series address unique, so `create_series`
  // is genuinely exercised rather than short-circuited by an existing account.
  const mintKp = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(connection);
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: kp.publicKey,
      newAccountPubkey: mintKp.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKp.publicKey,
      8,
      kp.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await provider.sendAndConfirm(tx, [mintKp]);
  const collateralMint = mintKp.publicKey;
  console.log("   collateral   ", collateralMint.toBase58(), "(Token-2022, 8 dec)");

  // --- 04 approve the collateral ----------------------------------------
  const approvedCollateral = PublicKey.findProgramAddressSync(
    [seed("approved-collateral"), collateralMint.toBuffer()],
    factory.programId,
  )[0];
  await factory.methods
    .approveCollateral()
    .accounts({
      payer: kp.publicKey,
      admin: kp.publicKey,
      factory: factoryPda,
      collateralMint,
      approval: approvedCollateral,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("04 collateral   approved");

  // --- 05 create the series ---------------------------------------------
  const strike = new BN(Math.round(150 * 1e8));
  const maturityTs = new BN(Math.floor(Date.now() / 1000) + 30 * 86_400);
  const seriesAddress = PublicKey.findProgramAddressSync(
    [
      seed("series"),
      factoryPda.toBuffer(),
      collateralMint.toBuffer(),
      i128le(strike),
      i64le(maturityTs),
    ],
    series.programId,
  )[0];
  const pMint = PublicKey.findProgramAddressSync(
    [seed("p-mint"), seriesAddress.toBuffer()],
    series.programId,
  )[0];
  const nMint = PublicKey.findProgramAddressSync(
    [seed("n-mint"), seriesAddress.toBuffer()],
    series.programId,
  )[0];
  const record = PublicKey.findProgramAddressSync(
    [seed("record"), seriesAddress.toBuffer()],
    factory.programId,
  )[0];
  // The factory declares this UncheckedAccount, so it carries no IDL seeds:
  // it is the series' collateral ATA, off-curve because the owner is a PDA.
  const collateralVault = getAssociatedTokenAddressSync(
    collateralMint,
    seriesAddress,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  await factory.methods
    .createSeries({
      strike,
      maturityTs,
      priceDecimals: 8,
      settlementDelaySecs: new BN(0),
      maxOracleAgeSecs: new BN(86_400),
      maxPriceLagSecs: new BN(86_400),
      minSplitAmount: new BN(1),
      feeBps: 0,
    })
    // Names mirror `createSeriesIx` in web/lib/actions.ts exactly — that map is
    // what this script exists to validate.
    .accounts({
      payer: kp.publicKey,
      admin: kp.publicKey,
      factory: factoryPda,
      seriesAdmin: kp.publicKey,
      oracleApproval: approvedOracle,
      collateralApproval: approvedCollateral,
      feedConfig,
      collateralMint,
      series: seriesAddress,
      collateralVault,
      pMint,
      nMint,
      feeRecipient: kp.publicKey,
      record,
      seriesProgram: series.programId,
      collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("05 series       created", seriesAddress.toBase58());

  const cfg = await series.account.seriesConfig.fetch(seriesAddress);
  console.log("   strike       ", cfg.strike.toString());
  console.log("   maturity_ts  ", cfg.maturityTs.toString());
  console.log("   status       ", Object.keys(cfg.status)[0]);
  console.log("   p/n mint     ", cfg.pMint.toBase58(), cfg.nMint.toBase58());

  // A classic SPL Token mint for the book to quote in.
  const quoteKp = Keypair.generate();
  const qtx = new anchor.web3.Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: kp.publicKey,
      newAccountPubkey: quoteKp.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(quoteKp.publicKey, 6, kp.publicKey, null, TOKEN_PROGRAM_ID),
  );
  await provider.sendAndConfirm(qtx, [quoteKp]);
  console.log("   quote mint   ", quoteKp.publicKey.toBase58(), "(SPL Token, 6 dec)");

  console.log("\nnext:");
  console.log(
    `  node scripts/verify-book-creation.mjs ${seriesAddress.toBase58()} ${quoteKp.publicKey.toBase58()}`,
  );
}

main().catch((e) => {
  console.error("\nFAILED:", e.message ?? e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
