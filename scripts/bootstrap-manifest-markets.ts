// SPDX-License-Identifier: Apache-2.0
//
// Prepare every registered P/cash and N/cash market before traders arrive.
// Inspect only:
//   pnpm manifest:bootstrap
// Execute on devnet:
//   pnpm manifest:bootstrap -- --execute

import * as anchor from "@coral-xyz/anchor";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { QUOTE_MINT as DEVNET_QUOTE_MINT } from "../web/lib/deployment";
import {
  MAGICBLOCK_DELEGATION_PROGRAM_ID,
  MANIFEST_PROGRAM_ID,
  createManifestMarketIxs,
  delegateManifestMarketIx,
  loadManifestMarket,
  manifestMarketPda,
  prepareManifestMarketCustodyIxs,
} from "../web/lib/manifest";

const { AnchorProvider, Program, Wallet } = anchor;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEFAULT_L1 = "https://api.devnet.solana.com";
const DEFAULT_ROLLUP = "https://devnet.magicblock.app";
const EXPECTED_MANIFEST = "HTBtzS8fV9Bw1pGRQZEZqYtu49jJLLUjU5msQWaUKfBE";
const factoryIdl = JSON.parse(fs.readFileSync("web/lib/idl/factory.json", "utf8"));
const seriesIdl = JSON.parse(fs.readFileSync("web/lib/idl/series.json", "utf8"));
const SERIES_PROGRAM_ID = new PublicKey(seriesIdl.address);
const claimMint = (series: PublicKey, leg: "P" | "N") =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(leg === "P" ? "p-mint" : "n-mint"), series.toBuffer()],
    SERIES_PROGRAM_ID,
  )[0];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function option(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function payer() {
  const walletPath = path.resolve(
    option("--keypair") ??
      process.env.ANCHOR_WALLET ??
      path.join(os.homedir(), ".config/solana/id.json"),
  );
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
}

async function send(
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[],
  label: string,
) {
  if (!instructions.length) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(...instructions),
        [signer],
        { commitment: "confirmed" },
      );
      console.log(`  ${label}: ${signature}`);
      return;
    } catch (error) {
      if (attempt === 3 || !/Blockhash not found|block height exceeded/i.test(String(error))) {
        throw error;
      }
      console.log(`  ${label}: expired blockhash, retrying (${attempt}/3)`);
    }
  }
}

async function waitForOwner(
  connection: Connection,
  address: PublicKey,
  expected: PublicKey,
  label: string,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const info = await connection.getAccountInfo(address, "confirmed");
    if (info?.owner.equals(expected)) return;
    await sleep(250);
  }
  throw new Error(`${label} did not become owned by ${expected.toBase58()}`);
}

async function validatorIdentity(connection: Connection) {
  const response = await (connection as any)._rpcRequest("getIdentity", []);
  const identity = response?.result?.identity;
  if (!identity) throw new Error("MagicBlock getIdentity returned no validator");
  return new PublicKey(identity);
}

async function main() {
  const execute = process.argv.includes("--execute");
  const onlySeries = option("--series");
  const signer = payer();
  const l1 = new Connection(process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_L1, "confirmed");
  const rollup = new Connection(
    process.env.NEXT_PUBLIC_EPHEMERAL_RPC_URL || DEFAULT_ROLLUP,
    "confirmed",
  );

  const genesis = await l1.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`refusing cluster ${genesis}; this command is devnet-only`);
  }
  if (MANIFEST_PROGRAM_ID.toBase58() !== EXPECTED_MANIFEST) {
    throw new Error(
      `refusing Manifest ${MANIFEST_PROGRAM_ID.toBase58()}; expected ${EXPECTED_MANIFEST}`,
    );
  }
  for (const [label, address] of [
    ["Manifest", MANIFEST_PROGRAM_ID],
    ["quote mint", DEVNET_QUOTE_MINT],
  ] as const) {
    const info = await l1.getAccountInfo(address, "confirmed");
    if (!info) throw new Error(`${label} ${address.toBase58()} is missing`);
    if (label === "Manifest" && !info.executable) throw new Error("Manifest is not executable");
    if (label === "quote mint" && !info.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error(`quote mint is owned by ${info.owner.toBase58()}, not classic SPL Token`);
    }
  }

  const validator = await validatorIdentity(rollup);
  const provider = new AnchorProvider(l1, new Wallet(signer), { commitment: "confirmed" });
  const factory = new Program(factoryIdl as any, provider);
  const seriesProgram = new Program(seriesIdl as any, provider);
  const records = await (factory.account as any).seriesRecord.all();
  const selected = onlySeries
    ? records.filter((row: any) => row.account.series.toBase58() === onlySeries)
    : records;
  if (onlySeries && selected.length !== 1) throw new Error(`series ${onlySeries} is not registered`);

  console.log(`${execute ? "EXECUTE" : "INSPECT"} ${selected.length * 2} books`);
  console.log(`payer     ${signer.publicKey.toBase58()}`);
  console.log(`Manifest  ${MANIFEST_PROGRAM_ID.toBase58()}`);
  console.log(`quote     ${DEVNET_QUOTE_MINT.toBase58()}`);
  console.log(`validator ${validator.toBase58()}`);

  for (const row of selected) {
    const series = row.account.series as PublicKey;
    const config = await (seriesProgram.account as any).seriesConfig.fetch(series);
    for (const [leg, baseMint] of [
      ["P", claimMint(series, "P")],
      ["N", claimMint(series, "N")],
    ] as const) {
      const market = manifestMarketPda(baseMint, DEVNET_QUOTE_MINT, MANIFEST_PROGRAM_ID);
      const info = await l1.getAccountInfo(market, "confirmed");
      const state = !info
        ? "absent"
        : info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID)
          ? "live"
          : info.owner.equals(MANIFEST_PROGRAM_ID)
            ? "prepared on L1"
            : `unexpected owner ${info.owner.toBase58()}`;
      console.log(`\n${series.toBase58()} ${leg} ${market.toBase58()} · ${state}`);
      if (!execute) continue;
      if (info && !info.owner.equals(MANIFEST_PROGRAM_ID) && !info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID)) {
        throw new Error(`${market.toBase58()} has ${state}`);
      }

      if (!info) {
        const created = createManifestMarketIxs({
          payer: signer.publicKey,
          baseMint,
          quoteMint: DEVNET_QUOTE_MINT,
          maturityTimestamp: BigInt(config.maturityTs.toString()),
          programId: MANIFEST_PROGRAM_ID,
        });
        await send(l1, signer, created.ixs, "created and expanded");
      }

      const afterCreate = await l1.getAccountInfo(market, "confirmed");
      if (afterCreate?.owner.equals(MANIFEST_PROGRAM_ID)) {
        for (const mint of [baseMint, DEVNET_QUOTE_MINT]) {
          const custody = await prepareManifestMarketCustodyIxs({
            connection: l1,
            payer: signer.publicKey,
            market,
            mints: [mint],
            validator,
          });
          await send(l1, signer, custody, `prepared ${mint.toBase58()}`);
        }
        await send(
          l1,
          signer,
          [
            await delegateManifestMarketIx({
              payer: signer.publicKey,
              market,
              validator,
              programId: MANIFEST_PROGRAM_ID,
            }),
          ],
          "delegated market",
        );
      }

      await waitForOwner(l1, market, MAGICBLOCK_DELEGATION_PROGRAM_ID, "L1 market");
      await waitForOwner(rollup, market, MANIFEST_PROGRAM_ID, "MagicBlock market");
      const loaded = await loadManifestMarket(rollup, market, MANIFEST_PROGRAM_ID);
      if (!loaded.session.active || !loaded.session.ephemeralCustody) {
        throw new Error(`${market.toBase58()} is delegated but its live session is incomplete`);
      }
      console.log("  verified live on MagicBlock");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
