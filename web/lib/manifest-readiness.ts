import type { AccountInfo, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { MAGICBLOCK_DELEGATION_PROGRAM_ID } from "./manifest.ts";

const SESSION_ACTIVE_OFFSET = 232;
const SESSION_CUSTODY_OFFSET = 240;
const MINIMUM_SESSION_BYTES = SESSION_CUSTODY_OFFSET + 8;

type AccountReader = Pick<Connection, "getAccountInfo">;

export type ManifestBookReadiness =
  | { kind: "missing" }
  | { kind: "on-l1" }
  | { kind: "delegating"; reason: string }
  | { kind: "live" }
  | { kind: "invalid"; reason: string };

const ownerIs = (account: AccountInfo<Buffer>, owner: PublicKey) =>
  account.owner.equals(owner);

/**
 * Read the complete execution state of one Manifest book.
 *
 * L1 ownership alone is not enough: the delegation program can already own
 * the account while the validator has not materialized a usable session yet.
 * A market is live only when the validator serves the Manifest-owned copy and
 * that copy says both the session and ephemeral custody are active.
 */
export async function manifestBookReadiness({
  l1,
  rollup,
  market,
  programId,
}: {
  l1: AccountReader;
  rollup: AccountReader;
  market: PublicKey;
  programId: PublicKey;
}): Promise<ManifestBookReadiness> {
  const l1Account = await l1.getAccountInfo(market, "confirmed");
  if (!l1Account) return { kind: "missing" };
  if (ownerIs(l1Account, programId)) return { kind: "on-l1" };
  if (!ownerIs(l1Account, MAGICBLOCK_DELEGATION_PROGRAM_ID)) {
    return {
      kind: "invalid",
      reason: `unexpected L1 owner ${l1Account.owner.toBase58()}`,
    };
  }

  const rollupAccount = await rollup.getAccountInfo(market, "confirmed");
  if (!rollupAccount) {
    return { kind: "delegating", reason: "the validator has not received the market yet" };
  }
  if (!ownerIs(rollupAccount, programId)) {
    return {
      kind: "invalid",
      reason: `unexpected MagicBlock owner ${rollupAccount.owner.toBase58()}`,
    };
  }
  if (rollupAccount.data.length < MINIMUM_SESSION_BYTES) {
    return { kind: "invalid", reason: "the MagicBlock market data is truncated" };
  }

  const active = rollupAccount.data.readBigUInt64LE(SESSION_ACTIVE_OFFSET) === BigInt(1);
  const custody = rollupAccount.data.readBigUInt64LE(SESSION_CUSTODY_OFFSET) === BigInt(1);
  if (!active || !custody) {
    return {
      kind: "delegating",
      reason: !active
        ? "the Manifest execution session is not active"
        : "ephemeral custody is not active",
    };
  }
  return { kind: "live" };
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Wait for asynchronous MagicBlock delegation to become fully tradable. */
export async function waitForManifestBookLive(
  input: Parameters<typeof manifestBookReadiness>[0],
  options: { attempts?: number; intervalMs?: number } = {},
) {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 500;
  let latest: ManifestBookReadiness = { kind: "missing" };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await manifestBookReadiness(input);
    if (latest.kind === "live") return;
    if (latest.kind === "invalid") {
      throw new Error(`Manifest market ${input.market.toBase58()} is invalid: ${latest.reason}.`);
    }
    if (attempt + 1 < attempts) await pause(intervalMs);
  }

  const detail = latest.kind === "delegating" ? latest.reason : latest.kind;
  throw new Error(
    `Manifest market ${input.market.toBase58()} did not become live on MagicBlock (${detail}).`,
  );
}
