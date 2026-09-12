// SPDX-License-Identifier: Apache-2.0
//
// One-time handoff of the public devnet factory from the seller fixture to the
// dedicated admin fixture. The guards are intentionally specific: an authority
// migration should stop rather than guess if the cluster, program, PDA, current
// authority, destination, or signer differs from the state reviewed here.
//
// Inspect and simulate only:
//   pnpm migrate:devnet-admin -- --test-seller
//
// Submit after the simulation succeeds:
//   pnpm migrate:devnet-admin -- --test-seller --execute
//
// A JSON keypair may be supplied instead of the committed public test fixture:
//   pnpm migrate:devnet-admin -- --keypair /path/to/current-admin.json --execute

import anchor from "@coral-xyz/anchor";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

const { AnchorProvider, Program, Wallet } = anchor;

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const FACTORY_PROGRAM = new PublicKey("CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ");
const FACTORY_PDA = new PublicKey("3KXBFf1iLXxu3VVutcobRNiNwxkKAEenif7aKX5LFUWY");
const SELLER_ADMIN = new PublicKey("8jLo1GkfgViEf5ptfACdNP47xioREfFcg3Bz36uAEmAi");
const DEDICATED_ADMIN = new PublicKey("tmM8kECJyA5DtAqUwuwMk2Xuheqk5b18ckbCrhSUBSw");
const DEFAULT_RPC = "https://api.devnet.solana.com";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function publicSellerFixture() {
  const sourcePath = path.join(root, "web/lib/test-wallets.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const match = source.match(/seller:\s*\[([^\]]+)\]/);
  if (!match) throw new Error(`seller fixture not found in ${sourcePath}`);
  const bytes = match[1].split(",").map((part) => Number(part.trim()));
  if (bytes.length !== 64 || bytes.some((byte) => !Number.isInteger(byte))) {
    throw new Error("seller fixture is not a 64-byte keypair");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function signer() {
  const keypairPath = valueAfter("--keypair");
  const useFixture = process.argv.includes("--test-seller");
  if (keypairPath && useFixture) {
    throw new Error("choose either --keypair or --test-seller, not both");
  }
  if (useFixture) return publicSellerFixture();
  if (keypairPath) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf8"))),
    );
  }
  return null;
}

async function factoryState(connection, program) {
  const info = await connection.getAccountInfo(FACTORY_PDA, "confirmed");
  if (!info) throw new Error(`factory ${FACTORY_PDA.toBase58()} does not exist`);
  if (!info.owner.equals(FACTORY_PROGRAM)) {
    throw new Error(`factory owner is ${info.owner.toBase58()}, expected ${FACTORY_PROGRAM}`);
  }
  return program.coder.accounts.decode("factoryState", info.data);
}

async function signedTransaction(connection, program, currentAdmin) {
  const instruction = await program.methods
    .setAdmin(DEDICATED_ADMIN)
    .accounts({ admin: currentAdmin.publicKey, factory: FACTORY_PDA })
    .instruction();
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: currentAdmin.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(instruction);
  transaction.sign(currentAdmin);
  return { transaction, latest };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("pnpm migrate:devnet-admin -- (--test-seller | --keypair <file>) [--execute] [--url <rpc>]");
    return;
  }

  const rpc = valueAfter("--url") ?? DEFAULT_RPC;
  const execute = process.argv.includes("--execute");
  const connection = new Connection(rpc, "confirmed");

  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`refusing cluster with genesis ${genesis}; expected devnet ${DEVNET_GENESIS}`);
  }

  const idl = JSON.parse(fs.readFileSync(path.join(root, "web/lib/idl/factory.json"), "utf8"));
  if (idl.address !== FACTORY_PROGRAM.toBase58()) {
    throw new Error(`factory IDL names ${idl.address}, expected ${FACTORY_PROGRAM.toBase58()}`);
  }
  const derived = PublicKey.findProgramAddressSync([Buffer.from("factory")], FACTORY_PROGRAM)[0];
  if (!derived.equals(FACTORY_PDA)) {
    throw new Error(`derived factory ${derived.toBase58()} does not match reviewed PDA ${FACTORY_PDA}`);
  }

  const currentAdmin = signer();
  const readWallet = currentAdmin ?? Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(readWallet), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const before = await factoryState(connection, program);

  console.log(`cluster       devnet (${genesis})`);
  console.log(`factory       ${FACTORY_PDA.toBase58()}`);
  console.log(`current admin ${before.admin.toBase58()}`);
  console.log(`new admin     ${DEDICATED_ADMIN.toBase58()}`);

  if (before.admin.equals(DEDICATED_ADMIN)) {
    console.log("already migrated; no transaction needed");
    return;
  }
  if (!before.admin.equals(SELLER_ADMIN)) {
    throw new Error(`refusing unexpected current admin ${before.admin.toBase58()}`);
  }
  if (!currentAdmin) {
    throw new Error("the current admin signer is required: use --test-seller or --keypair <file>");
  }
  if (!currentAdmin.publicKey.equals(SELLER_ADMIN)) {
    throw new Error(`signer is ${currentAdmin.publicKey.toBase58()}, expected ${SELLER_ADMIN}`);
  }

  const balance = await connection.getBalance(currentAdmin.publicKey, "confirmed");
  if (balance < 10_000) throw new Error("current admin has insufficient SOL for the transaction fee");

  const simulated = await signedTransaction(connection, program, currentAdmin);
  const simulation = await connection.simulateTransaction(simulated.transaction);
  if (simulation.value.err) {
    throw new Error(`simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  console.log("simulation    passed");

  if (!execute) {
    console.log("dry run only; pass --execute to submit");
    return;
  }

  const submitted = await signedTransaction(connection, program, currentAdmin);
  const signature = await connection.sendRawTransaction(submitted.transaction.serialize(), {
    skipPreflight: false,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, ...submitted.latest },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  const after = await factoryState(connection, program);
  if (!after.admin.equals(DEDICATED_ADMIN)) {
    throw new Error(`transaction confirmed but factory admin is ${after.admin.toBase58()}`);
  }
  console.log(`signature     ${signature}`);
  console.log(`verified      factory admin is ${after.admin.toBase58()}`);
}

main().catch((error) => {
  console.error(`migration failed: ${error.message}`);
  process.exit(1);
});
