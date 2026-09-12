import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  genesisMatches,
  parseNetwork,
  validatePublicNetworkConfig,
} from "../lib/network-config.ts";
import { backedXstocksIssuer } from "../lib/issuers/backed-xstocks.ts";

test("only explicit supported network names are accepted", () => {
  assert.equal(parseNetwork("devnet"), "devnet");
  assert.equal(parseNetwork("mainnet"), "mainnet-beta");
  assert.equal(parseNetwork("mainnet-beta"), "mainnet-beta");
  assert.throws(() => parseNetwork("mainet"), /Unsupported Erodoro network/);
});

test("network identity is the genesis hash, not the build label", () => {
  assert.equal(genesisMatches("devnet", DEVNET_GENESIS_HASH), true);
  assert.equal(genesisMatches("mainnet-beta", MAINNET_GENESIS_HASH), true);
  assert.equal(genesisMatches("devnet", MAINNET_GENESIS_HASH), false);
  assert.equal(genesisMatches("mainnet-beta", DEVNET_GENESIS_HASH), false);
});

test("mainnet has no implicit RPC or MagicBlock endpoint", () => {
  assert.deepEqual(
    validatePublicNetworkConfig({ network: "mainnet-beta" }),
    [
      "Mainnet requires NEXT_PUBLIC_MAINNET_RPC_URL.",
      "Mainnet requires NEXT_PUBLIC_EPHEMERAL_RPC_URL.",
    ],
  );
  assert.deepEqual(
    validatePublicNetworkConfig({
      network: "mainnet-beta",
      rpcUrl: "https://mainnet.example",
      ephemeralRpcUrl: "https://magicblock.example",
    }),
    [],
  );
});

test("demo keys and signing are defended by the verified network boundary", () => {
  const wallets = fs.readFileSync(new URL("../lib/test-wallets.ts", import.meta.url), "utf8");
  const boundary = fs.readFileSync(new URL("../components/network-boundary.tsx", import.meta.url), "utf8");
  const send = fs.readFileSync(new URL("../lib/use-send.ts", import.meta.url), "utf8");

  assert.match(wallets, /return IS_DEVNET/);
  assert.doesNotMatch(wallets, /cluster !== "mainnet/);
  assert.match(boundary, /getGenesisHash\(\)/);
  assert.match(boundary, /genesisMatches\(ACTIVE_NETWORK, actualGenesis\)/);
  assert.match(send, /if \(!network\.mutationsAllowed\)/);
});

test("the production issuer adapter recognizes only canonical configured mints", () => {
  const tslax = backedXstocksIssuer.asset(
    "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  );
  assert.equal(tslax?.symbol, "TSLAx");
  assert.equal(tslax?.issuer, "Backed Assets (JE) Limited");
  assert.equal(backedXstocksIssuer.asset("11111111111111111111111111111111"), null);
});

test("the checked Mainnet manifest contains no invented deployment addresses", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.cluster, "mainnet-beta");
  assert.equal(manifest.ready, false);
  assert.equal(manifest.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.ok(Object.values(manifest.programs).every((value) => value === null));
});
