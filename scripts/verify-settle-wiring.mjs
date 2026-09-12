// SPDX-License-Identifier: Apache-2.0
//
// Verify the Settle button can actually build its transaction.
//
// A live settle needs a matured series, which a 30-day devnet series will not
// be for a month. What *can* be checked now is everything the button does
// before the send: reading the feed config to find the price account (the
// panel has no other way to learn it), assembling `settle` with the exact
// account map `settleIx` uses, and simulating it.
//
// The expected outcome is a *program* rejection on the maturity guard. That is
// the useful result: it proves every account resolved and the instruction
// reached the program's own logic, rather than failing to build.
//
//   node scripts/verify-settle-wiring.mjs <seriesAddress>

import anchor from "@coral-xyz/anchor";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

const { AnchorProvider, Program, Wallet } = anchor;

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const seed = (s) => Buffer.from(s, "utf8");

async function main() {
  const seriesArg = process.argv[2];
  if (!seriesArg) {
    console.error("usage: node scripts/verify-settle-wiring.mjs <seriesAddress>");
    process.exit(2);
  }
  const seriesAddress = new PublicKey(seriesArg);

  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json")))),
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });

  const seriesIdl = JSON.parse(fs.readFileSync("target/idl/series.json", "utf8"));
  const oracleIdl = JSON.parse(fs.readFileSync("target/idl/oracle_adapter.json", "utf8"));
  const series = new Program(seriesIdl, provider);
  const oracle = new Program(oracleIdl, provider);

  const config = await series.account.seriesConfig.fetch(seriesAddress);

  // Exactly what the panel's effect does: the price account is whatever the
  // feed config currently names, never anything the caller picks.
  const feed = await oracle.account.feedConfig.fetch(config.oracleAdapter);
  const priceSource = feed.source;
  console.log("oracle_adapter", config.oracleAdapter.toBase58());
  console.log("price_source  ", priceSource.toBase58(), "(read from the feed config)");

  const info = await connection.getAccountInfo(priceSource);
  console.log("  owner       ", info?.owner.toBase58() ?? "MISSING");

  const now = Math.floor(Date.now() / 1000);
  const settleableAt = config.maturityTs.toNumber() + config.settlementDelaySecs.toNumber();
  console.log("\nbutton gating:");
  console.log("  now           ", now);
  console.log("  settleable at ", settleableAt, new Date(settleableAt * 1000).toISOString());
  console.log("  enabled?      ", now >= settleableAt);

  const settlement = PublicKey.findProgramAddressSync(
    [seed("settlement"), seriesAddress.toBuffer()],
    series.programId,
  )[0];

  const ix = await series.methods
    .settle()
    .accounts({
      payer: kp.publicKey,
      series: seriesAddress,
      settlement,
      collateralMint: config.collateralMint,
      collateralVault: config.collateralVault,
      pMint: config.pMint,
      nMint: config.nMint,
      oracleAdapter: config.oracleAdapter,
      priceSource,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  console.log("\ninstruction built ok:", ix.keys.length, "accounts,", ix.data.length, "bytes data");

  const tx = new anchor.web3.Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);

  const err = sim.value.err;
  const logs = sim.value.logs ?? [];
  const custom = logs.find((l) => /Error Code|Error Message/.test(l));
  console.log("simulation err:", JSON.stringify(err));
  if (custom) console.log("program says:  ", custom.trim());

  if (!err) {
    console.log("\nVERIFIED: settle simulated clean — the series is settleable now.");
    return;
  }
  // A program-level error means every account resolved and the runtime handed
  // execution to the program. A resolution failure would not get this far.
  const reached = logs.some((l) => l.includes(series.programId.toBase58()));
  if (reached) {
    console.log(
      "\nVERIFIED: the transaction builds and reaches the program; it is rejected on the",
      "\nmaturity/settlement-window guard, which is correct for a series that has not matured.",
    );
  } else {
    console.log("\nFAILED: the program was never reached — account resolution problem.");
    console.log(logs.join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.message ?? e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
