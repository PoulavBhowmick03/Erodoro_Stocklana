// Opens a market and both books for a series, with a fresh classic-SPL cash
// mint funding both test keys. Mirrors exactly what the app now builds.
import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getMintLen,
} from "@solana/spl-token";
import fs from "node:fs";

const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
const SELLER = [77,191,172,7,191,162,97,7,235,239,112,49,11,238,84,50,159,63,12,9,95,228,236,66,197,59,233,34,148,89,64,124,114,218,149,43,49,120,184,46,53,142,227,137,112,166,137,186,242,52,96,37,108,58,19,182,101,50,84,130,243,146,243,187];
const BUYER = new PublicKey("12hDxJowXTSJBDCGTJXejA551otZomokdzkVbRL8okgv");
const SERIES = new PublicKey(process.argv[2] ?? "7fk5Ab2vvJDGw6S92YoWPp8c39KbzGCty7vojuptTQ15");
const SERIES_PROGRAM = new PublicKey("AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9");
const MARKET_PROGRAM = new PublicKey("FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC");

const payer = Keypair.fromSecretKey(Uint8Array.from(SELLER));
const url = (fs.readFileSync(".env.local","utf8").split("\n").find(l=>l.startsWith("NEXT_PUBLIC_RPC_URL="))??"").slice(20).trim();
const connection = new Connection(url || "https://api.devnet.solana.com", "confirmed");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const market = new Program(JSON.parse(fs.readFileSync("lib/idl/market.json","utf8")), provider);
const seriesProg = new Program(JSON.parse(fs.readFileSync("lib/idl/series.json","utf8")), provider);

const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const seed = (s) => Buffer.from(s);
const send = async (ixs, signers=[]) => {
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const l = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...l }, "confirmed");
  return sig;
};

const cfg = await seriesProg.account.seriesConfig.fetch(SERIES);
console.log("series      ", SERIES.toBase58(), "maturity", cfg.maturityTs.toString());

// 1. cash mint, funding both keys
const mintKp = Keypair.generate();
const len = getMintLen([]);
const lamports = await connection.getMinimumBalanceForRentExemption(len);
const raw = BigInt(100_000 * 10 ** 6);
const ixs = [
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports, programId: TOKEN_PROGRAM_ID }),
  createInitializeMintInstruction(mintKp.publicKey, 6, payer.publicKey, null, TOKEN_PROGRAM_ID),
];
for (const owner of [payer.publicKey, BUYER]) {
  const ata = getAssociatedTokenAddressSync(mintKp.publicKey, owner, false, TOKEN_PROGRAM_ID);
  ixs.push(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mintKp.publicKey, TOKEN_PROGRAM_ID),
    createMintToInstruction(mintKp.publicKey, ata, payer.publicKey, raw, [], TOKEN_PROGRAM_ID),
  );
}
console.log("cash mint   ", mintKp.publicKey.toBase58(), "→", (await send(ixs, [mintKp])).slice(0, 12) + "…");

// 2. market
const ixMarket = await market.methods.initializeMarket(cfg.maturityTs).accounts({
  payer: payer.publicKey, series: SERIES,
  pMint: pda([seed("p-mint"), SERIES.toBuffer()], SERIES_PROGRAM),
  nMint: pda([seed("n-mint"), SERIES.toBuffer()], SERIES_PROGRAM),
  quoteMint: mintKp.publicKey,
}).instruction();
const marketPda = pda([seed("market"), SERIES.toBuffer()], MARKET_PROGRAM);
console.log("market      ", marketPda.toBase58(), "→", (await send([ixMarket])).slice(0, 12) + "…");

// 3. both books
for (const [name, arg, tag] of [["P", { p: {} }, 0], ["N", { n: {} }, 1]]) {
  const book = pda([seed("book"), marketPda.toBuffer(), Buffer.from([tag])], MARKET_PROGRAM);
  const ix = await market.methods.initializeBook(arg).accounts({ payer: payer.publicKey, market: marketPda, book }).instruction();
  console.log(`book ${name}      `, book.toBase58(), "→", (await send([ix])).slice(0, 12) + "…");
}

const m = await market.account.market.fetch(marketPda);
console.log("\nverified: quoteMint", m.quoteMint.toBase58().slice(0, 8) + "…", "pVault/nVault/quoteVault created");
