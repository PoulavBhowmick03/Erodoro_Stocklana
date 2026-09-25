#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Read-only: quote actual artifacts, never load a wallet or send transactions.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" },
  "include-market": { type: "boolean", default: false },
  manifest: { type: "string" },
  deployed: { type: "string" },
  "lamports-per-byte": { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

if (values.help) {
  console.log(`Usage: pnpm deployment:cost [options]
  --rpc URL                  Rent quote RPC (default: mainnet)
  --include-market           Include the custom-market prototype
  --manifest PATH            Include an explicitly selected Manifest .so
  --deployed PATH            Read balances for a deployment JSON on this RPC
  --lamports-per-byte NUMBER Offline estimate with an explicit assumed rate
  --json                     Machine-readable report

Default scope: oracle_adapter, factory, series. Fees, temporary buffer funding,
state accounts and external programs are excluded unless specified. No wallet
is accessed and no transactions are sent.`);
  process.exit(0);
}

async function rpc(method, params = []) {
  const response = await fetch(values.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function main() {
  const rate = values["lamports-per-byte"] === undefined
    ? undefined : Number(values["lamports-per-byte"]);
  if (rate !== undefined && (!Number.isSafeInteger(rate) || rate <= 0)) {
    throw new Error("--lamports-per-byte must be a positive integer");
  }
  if (rate !== undefined && values.deployed) {
    throw new Error("--deployed requires live RPC quotes, not an offline rate");
  }
  const cache = new Map();
  async function rent(bytes) {
    if (!cache.has(bytes)) cache.set(bytes, rate === undefined
      ? await rpc("getMinimumBalanceForRentExemption", [bytes, { commitment: "confirmed" }])
      : (bytes + 128) * rate);
    const amount = cache.get(bytes);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid rent quote");
    return amount;
  }
  const names = ["oracle_adapter", "factory", "series"];
  if (values["include-market"]) names.push("market");
  const programLamports = await rent(36); // loader-v3 Program account
  async function artifact(file) {
    const data = fs.readFileSync(file);
    if (data.length < 64 || !data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
      throw new Error(`Not an ELF artifact: ${file}`);
    }
    // ProgramData has a 45-byte header in addition to the ELF allocation.
    const programDataLamports = await rent(data.length + 45);
    return { path: path.relative(root, file), bytes: data.length,
      programDataLamports, programLamports,
      totalLamports: programDataLamports + programLamports };
  }
  const programs = [];
  for (const name of names) {
    const variant = name.replaceAll("_", "-");
    programs.push({ name,
      anchor: await artifact(path.join(root, "target/deploy", `${name}.so`)),
      pinocchio: await artifact(path.join(root, `variants/${variant}-pinocchio/target/deploy/${name}_pinocchio.so`)),
    });
  }
  const externalManifest = values.manifest ? await artifact(path.resolve(values.manifest)) : null;
  const sum = (kind) => programs.reduce((n, p) => n + p[kind].totalLamports, 0)
    + (externalManifest?.totalLamports ?? 0);
  const report = { measuredAt: new Date().toISOString(),
    rentSource: rate === undefined ? values.rpc : `offline assumption: ${rate} lamports/byte`,
    programs, externalManifest,
    totals: { anchorLamports: sum("anchor"), pinocchioLamports: sum("pinocchio"),
      savedLamports: sum("anchor") - sum("pinocchio") },
    exclusions: ["transaction/priority fees", "temporary deployment buffer funding",
      "protocol state accounts", "external programs unless explicitly supplied"],
  };
  if (values.deployed) {
    const deployment = JSON.parse(fs.readFileSync(path.resolve(values.deployed), "utf8"));
    if (!deployment.genesisHash || await rpc("getGenesisHash") !== deployment.genesisHash) {
      throw new Error("Deployment genesis hash does not match the selected RPC");
    }
    report.deployed = [];
    for (const [name, address] of Object.entries(deployment.programs)) {
      if (!address) continue;
      const program = (await rpc("getAccountInfo", [address, { encoding: "jsonParsed" }])).value;
      const programDataAddress = program?.data?.parsed?.info?.programData;
      if (!program?.executable || !programDataAddress) throw new Error(`${name}: no loader-v3 program at ${address}`);
      const data = (await rpc("getAccountInfo", [programDataAddress,
        { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value;
      if (!data || !Number.isSafeInteger(data.space) || data.space < 45) throw new Error(`${name}: invalid ProgramData`);
      report.deployed.push({ name, address, allocatedBytes: data.space - 45,
        lockedLamports: program.lamports + data.lamports,
        currentMinimumLamports: programLamports + await rent(data.space) });
    }
  }
  if (values.json) return console.log(JSON.stringify(report, null, 2));
  const sol = (lamports) => (lamports / 1e9).toFixed(9);
  console.log(`Rent source: ${report.rentSource}`);
  console.table(programs.map(p => ({ program: p.name,
    "Anchor bytes": p.anchor.bytes, "Pinocchio bytes": p.pinocchio.bytes,
    "Anchor SOL": sol(p.anchor.totalLamports), "Pinocchio SOL": sol(p.pinocchio.totalLamports) })));
  if (externalManifest) console.log(`Manifest: ${externalManifest.bytes} bytes / ${sol(externalManifest.totalLamports)} SOL`);
  console.log(`Fresh deployment: Anchor ${sol(sum("anchor"))} SOL; Pinocchio ${sol(sum("pinocchio"))} SOL`);
  console.log(`Savings: ${sol(report.totals.savedLamports)} SOL`);
  if (report.deployed) console.table(report.deployed.map(p => ({ program: p.name,
    "allocated bytes": p.allocatedBytes, "locked SOL": sol(p.lockedLamports),
    "current minimum SOL": sol(p.currentMinimumLamports) })));
  console.log(`Excluded: ${report.exclusions.join(", ")}.`);
}

main().catch(error => {
  console.error(`Deployment cost failed: ${error.message}`);
  if (error.code === "ENOENT") console.error("Build artifacts with make build and make variants; check any supplied file paths.");
  process.exitCode = 1;
});
