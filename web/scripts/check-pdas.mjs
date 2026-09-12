// The frontend's PDA derivation, checked against accounts that actually exist
// on devnet. A wrong seed order or a missing leg tag would produce a valid-
// looking address that simply has nothing at it.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";

const MARKET_PROGRAM = new PublicKey("HMcxBp5pomEZxnYx3L3vikVJyRZov7HnFqPZuDcoWHuL");
const enc = new TextEncoder();
const seed = (s) => Buffer.from(enc.encode(s));

// Exactly what web/lib/pdas.ts computes.
const marketPda = (series) =>
  PublicKey.findProgramAddressSync([seed("market"), series.toBuffer()], MARKET_PROGRAM)[0];
const bookPda = (market, tag) =>
  PublicKey.findProgramAddressSync([seed("book"), market.toBuffer(), Buffer.from([tag])], MARKET_PROGRAM)[0];

// The devnet test's deterministic fixture series.
const fixture = (n) =>
  Keypair.fromSeed(crypto.createHash("sha256").update(`erodoro:devnet:${n}`).digest().subarray(0, 32));

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const series = fixture("series").publicKey;
const m = marketPda(series);
const b = bookPda(m, 1); // Leg::N

for (const [label, key] of [["market", m], ["book(N)", b]]) {
  const info = await conn.getAccountInfo(key);
  const owned = info && info.owner.equals(MARKET_PROGRAM);
  console.log(`  ${label.padEnd(8)} ${key.toBase58()}  ${info ? (owned ? "EXISTS, owned by market ✓" : "exists, other owner") : "MISSING ✗"}`);
}
