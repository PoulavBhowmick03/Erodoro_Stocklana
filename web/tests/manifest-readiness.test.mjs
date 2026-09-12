import test from "node:test";
import assert from "node:assert/strict";

import { PublicKey } from "@solana/web3.js";

import { MAGICBLOCK_DELEGATION_PROGRAM_ID } from "../lib/manifest.ts";
import {
  manifestBookReadiness,
  waitForManifestBookLive,
} from "../lib/manifest-readiness.ts";

const programId = new PublicKey("HTBtzS8fV9Bw1pGRQZEZqYtu49jJLLUjU5msQWaUKfBE");
const market = new PublicKey("11111111111111111111111111111111");
const unexpectedOwner = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const reader = (account) => ({
  getAccountInfo: async () => account,
});

const account = (owner, data = Buffer.alloc(256)) => ({
  data,
  executable: false,
  lamports: 1,
  owner,
  rentEpoch: 0,
});

test("a series is not tradable merely because its Manifest book exists on L1", async () => {
  const readiness = await manifestBookReadiness({
    l1: reader(account(programId)),
    rollup: reader(null),
    market,
    programId,
  });
  assert.deepEqual(readiness, { kind: "on-l1" });
});

test("delegation is not live until the validator serves an active custody session", async () => {
  const notMaterialized = await manifestBookReadiness({
    l1: reader(account(MAGICBLOCK_DELEGATION_PROGRAM_ID)),
    rollup: reader(null),
    market,
    programId,
  });
  assert.equal(notMaterialized.kind, "delegating");

  const inactiveData = Buffer.alloc(256);
  const inactive = await manifestBookReadiness({
    l1: reader(account(MAGICBLOCK_DELEGATION_PROGRAM_ID)),
    rollup: reader(account(programId, inactiveData)),
    market,
    programId,
  });
  assert.equal(inactive.kind, "delegating");
});

test("a book is live only with active execution and ephemeral custody", async () => {
  const data = Buffer.alloc(256);
  data.writeBigUInt64LE(BigInt(1), 232);
  data.writeBigUInt64LE(BigInt(1), 240);
  const readiness = await manifestBookReadiness({
    l1: reader(account(MAGICBLOCK_DELEGATION_PROGRAM_ID)),
    rollup: reader(account(programId, data)),
    market,
    programId,
  });
  assert.deepEqual(readiness, { kind: "live" });
});

test("unexpected ownership fails immediately instead of being reported as opening", async () => {
  const l1 = reader(account(unexpectedOwner));
  const input = { l1, rollup: reader(null), market, programId };
  const readiness = await manifestBookReadiness(input);
  assert.equal(readiness.kind, "invalid");
  await assert.rejects(
    waitForManifestBookLive(input, { attempts: 1, intervalMs: 0 }),
    /unexpected L1 owner/,
  );
});

test("missing books time out as incomplete rather than succeeding", async () => {
  await assert.rejects(
    waitForManifestBookLive(
      { l1: reader(null), rollup: reader(null), market, programId },
      { attempts: 1, intervalMs: 0 },
    ),
    /did not become live.*missing/,
  );
});
