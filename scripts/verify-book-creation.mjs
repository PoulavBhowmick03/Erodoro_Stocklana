// SPDX-License-Identifier: Apache-2.0
//
// Prove `initialize_market` + `initialize_book` work as the UI builds them.
//
// `web/scripts/check-accounts.mjs` audits the account *maps* against the IDL,
// but it cannot catch an argument encoded the wrong way or a PDA the client
// derives differently from the program. The only thing that settles those is
// landing the transaction, so this creates a real market and book on devnet
// against a real series.
//
//   node scripts/verify-book-creation.mjs <seriesAddress> <quoteMint>
//
// Idempotent: if the market or book already exists it says so and moves on.

import anchor from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey, SystemProgram, Keypair, Connection } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const marketIdl = JSON.parse(fs.readFileSync("target/idl/market.json", "utf8"));
const seriesIdl = JSON.parse(fs.readFileSync("target/idl/series.json", "utf8"));

const seed = (s) => Buffer.from(s, "utf8");
const LEG = { P: { tag: 0, arg: { p: {} } }, N: { tag: 1, arg: { n: {} } } };

const marketPda = (series, programId) =>
  PublicKey.findProgramAddressSync([seed("market"), series.toBuffer()], programId)[0];
const bookPda = (market, leg, programId) =>
  PublicKey.findProgramAddressSync(
    [seed("book"), market.toBuffer(), Buffer.from([LEG[leg].tag])],
    programId,
  )[0];
const claimMintPda = (which, series, programId) =>
  PublicKey.findProgramAddressSync([seed(which), series.toBuffer()], programId)[0];

async function main() {
  const [seriesArg, quoteArg] = process.argv.slice(2);
  if (!seriesArg || !quoteArg) {
    console.error("usage: node scripts/verify-book-creation.mjs <seriesAddress> <quoteMint>");
    process.exit(2);
  }
  const seriesAddress = new PublicKey(seriesArg);
  const quoteMint = new PublicKey(quoteArg);

  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(kp), {
    commitment: "confirmed",
  });
  const market = new Program(marketIdl, provider);
  const series = new Program(seriesIdl, provider);

  const config = await series.account.seriesConfig.fetch(seriesAddress);
  const marketAddress = marketPda(seriesAddress, market.programId);
  const pMint = claimMintPda("p-mint", seriesAddress, series.programId);
  const nMint = claimMintPda("n-mint", seriesAddress, series.programId);

  console.log("series      ", seriesAddress.toBase58());
  console.log("maturity_ts ", config.maturityTs.toString());
  console.log("market pda  ", marketAddress.toBase58());
  console.log("p/n mint    ", pMint.toBase58(), nMint.toBase58());

  // --- initialize_market -------------------------------------------------
  if (await connection.getAccountInfo(marketAddress)) {
    console.log("\nmarket already exists — skipping initialize_market");
  } else {
    const sig = await market.methods
      .initializeMarket(config.maturityTs)
      .accounts({
        payer: kp.publicKey,
        series: seriesAddress,
        market: marketAddress,
        pMint,
        nMint,
        quoteMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("\ninitialize_market ok:", sig);
  }

  const m = await market.account.market.fetch(marketAddress);
  console.log("  market.series   ", m.series.toBase58());
  console.log("  market.pMint    ", m.pMint.toBase58());
  console.log("  market.quoteMint", m.quoteMint.toBase58());
  if (!m.series.equals(seriesAddress)) throw new Error("market.series mismatch");
  if (!m.pMint.equals(pMint)) throw new Error("market.p_mint mismatch");

  // --- initialize_book, both legs ----------------------------------------
  for (const leg of ["P", "N"]) {
    const book = bookPda(marketAddress, leg, market.programId);
    if (await connection.getAccountInfo(book)) {
      console.log(`book ${leg} already exists (${book.toBase58()})`);
      continue;
    }
    const sig = await market.methods
      .initializeBook(LEG[leg].arg)
      .accounts({
        payer: kp.publicKey,
        market: marketAddress,
        book,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`initialize_book ${leg} ok:`, sig);
  }

  for (const leg of ["P", "N"]) {
    const book = bookPda(marketAddress, leg, market.programId);
    const b = await market.account.book.fetch(book);
    const tag = Object.keys(b.leg)[0].toUpperCase();
    console.log(`  book ${leg} -> ${book.toBase58()} leg=${tag} orders=${b.orders.length}`);
    if (tag !== leg) throw new Error(`book ${leg} decoded leg=${tag} — Leg arg encoded wrong`);
    if (!b.market.equals(marketAddress)) throw new Error(`book ${leg} market mismatch`);
  }

  console.log("\nVERIFIED: market and both books exist and decode correctly.");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message ?? e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
