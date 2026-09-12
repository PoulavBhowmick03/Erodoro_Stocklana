#!/usr/bin/env node

import { PublicKey } from "@solana/web3.js";
import { validatePublicNetworkConfig } from "../lib/network-config.ts";

const target = process.env.NEXT_PUBLIC_NETWORK || process.env.NEXT_PUBLIC_CLUSTER || "devnet";
const errors = validatePublicNetworkConfig({
  network: target,
  rpcUrl: process.env.NEXT_PUBLIC_MAINNET_RPC_URL,
  ephemeralRpcUrl: process.env.NEXT_PUBLIC_EPHEMERAL_RPC_URL,
});

const mainnet = target === "mainnet" || target === "mainnet-beta";
const addressVariables = [
  "NEXT_PUBLIC_SERIES_PROGRAM_ID",
  "NEXT_PUBLIC_FACTORY_PROGRAM_ID",
  "NEXT_PUBLIC_ORACLE_ADAPTER_PROGRAM_ID",
  "NEXT_PUBLIC_MANIFEST_PROGRAM_ID",
];

if (mainnet) {
  for (const name of addressVariables) {
    const value = process.env[name];
    if (!value) {
      errors.push(`Mainnet requires ${name}.`);
      continue;
    }
    try {
      new PublicKey(value);
    } catch {
      errors.push(`${name} is not a valid Solana address.`);
    }
  }
  if (!process.env.NEXT_PUBLIC_ROLLUP_VALIDATOR) {
    errors.push("Mainnet requires NEXT_PUBLIC_ROLLUP_VALIDATOR.");
  } else {
    try {
      new PublicKey(process.env.NEXT_PUBLIC_ROLLUP_VALIDATOR);
    } catch {
      errors.push("NEXT_PUBLIC_ROLLUP_VALIDATOR is not a valid Solana address.");
    }
  }
}

if (errors.length) {
  console.error("Invalid Erodoro network configuration:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`[network] ${mainnet ? "mainnet-beta" : "devnet"} build configuration accepted`);
