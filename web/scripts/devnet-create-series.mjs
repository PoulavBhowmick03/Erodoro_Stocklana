// Builds and sends the real create_series instruction with the seller test key,
// the same account list the app now builds. If `collateralVault` were still
// missing, this fails to build with the exact error the UI showed.
import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "node:fs";

const { AnchorProvider, BN, Program, Wallet } = anchorPkg;

const SELLER = [77, 191, 172, 7, 191, 162, 97, 7, 235, 239, 112, 49, 11, 238, 84, 50, 159, 63, 12, 9, 95, 228, 236, 66, 197, 59, 233, 34, 148, 89, 64, 124, 114, 218, 149, 43, 49, 120, 184, 46, 53, 142, 227, 137, 112, 166, 137, 186, 242, 52, 96, 37, 108, 58, 19, 182, 101, 50, 84, 130, 243, 146, 243, 187];

const SERIES_PROGRAM = new PublicKey("AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9");
const FACTORY_PROGRAM = new PublicKey("CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ");
const ORACLE_PROGRAM = new PublicKey("FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz");
const FEED_ID = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex");
const MINT = new PublicKey(process.argv[2] ?? "FM8LPRj5ZnCx5nxUi4cAQcvCCqceGHvEMsnJeEH8idqA");

const seed = (s) => Buffer.from(s);
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const i128le = (v) => new BN(v).toTwos(128).toArrayLike(Buffer, "le", 16);
const i64le = (v) => new BN(v).toTwos(64).toArrayLike(Buffer, "le", 8);

const payer = Keypair.fromSecretKey(Uint8Array.from(SELLER));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const factoryIdl = JSON.parse(fs.readFileSync("lib/idl/factory.json", "utf8"));
const factory = new Program(factoryIdl, provider);

const factoryPda = pda([seed("factory")], FACTORY_PROGRAM);
const feedConfig = pda([seed("feed-config"), FEED_ID], ORACLE_PROGRAM);
const oracleApproval = pda([seed("approved-oracle"), feedConfig.toBuffer()], FACTORY_PROGRAM);
const collateralApproval = pda([seed("approved-collateral"), MINT.toBuffer()], FACTORY_PROGRAM);

// A strike and maturity nothing has used yet, so this is a fresh address.
const strike = new BN(Math.round(150 * 1e8));
const maturityTs = new BN(Math.floor(Date.now() / 1000) + 31 * 86_400);

const series = pda(
  [seed("series"), factoryPda.toBuffer(), MINT.toBuffer(), i128le(strike), i64le(maturityTs)],
  SERIES_PROGRAM,
);
const collateralVault = getAssociatedTokenAddressSync(MINT, series, true, TOKEN_2022_PROGRAM_ID);

console.log("payer          ", payer.publicKey.toBase58());
console.log("balance        ", (await connection.getBalance(payer.publicKey)) / 1e9, "SOL");
for (const [n, k] of [["factory", factoryPda], ["feedConfig", feedConfig], ["oracleApproval", oracleApproval], ["collateralApproval", collateralApproval]]) {
  console.log(`${n.padEnd(15)}`, k.toBase58(), (await connection.getAccountInfo(k)) ? "exists" : "MISSING");
}
console.log("series         ", series.toBase58());
console.log("collateralVault", collateralVault.toBase58());

const ix = await factory.methods
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
  .accounts({
    payer: payer.publicKey,
    admin: payer.publicKey,
    factory: factoryPda,
    seriesAdmin: payer.publicKey,
    oracleApproval,
    collateralApproval,
    feedConfig,
    collateralMint: MINT,
    series,
    collateralVault,
    pMint: pda([seed("p-mint"), series.toBuffer()], SERIES_PROGRAM),
    nMint: pda([seed("n-mint"), series.toBuffer()], SERIES_PROGRAM),
    feeRecipient: payer.publicKey,
    record: pda([seed("record"), series.toBuffer()], FACTORY_PROGRAM),
    seriesProgram: SERIES_PROGRAM,
    collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
  })
  .instruction();

console.log(`\nbuilt: ${ix.keys.length} accounts, no resolution error`);

const { Transaction } = await import("@solana/web3.js");
const tx = new Transaction().add(ix);
const { blockhash } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;
tx.feePayer = payer.publicKey;
tx.sign(payer);

try {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  console.log("sent   ", sig);
  const rec = pda([seed("record"), series.toBuffer()], FACTORY_PROGRAM);
  console.log("record ", (await connection.getAccountInfo(rec)) ? "written" : "MISSING");
  console.log("vault  ", (await connection.getAccountInfo(collateralVault)) ? "created" : "MISSING");
} catch (e) {
  console.log("\nSEND FAILED:", String(e).slice(0, 400));
  const logs = e?.logs ?? e?.transactionLogs;
  if (logs) console.log(logs.slice(-12).join("\n"));
  process.exit(1);
}
