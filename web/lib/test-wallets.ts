"use client";

import { Keypair } from "@solana/web3.js";
import { IS_DEVNET } from "./network-config";

/**
 * Three throwaway devnet keypairs: both sides of a trade, plus the registry
 * admin, all drivable from one browser.
 *
 * Testing a two-sided market otherwise means two wallet extensions, two
 * profiles, or a lot of disconnecting — and the seller/buyer toggle is useless
 * if switching roles does not also switch who signs.
 *
 * # These keys are public
 *
 * They are committed to a public repository. Anyone can read them and take the
 * SOL. That is fine for what they are — a devnet fixture holding about 1 SOL
 * each — and it is the reason for the guard below.
 *
 * They are refused on any cluster that is not devnet. Not a warning, not a
 * confirm dialog: `activeTestWallet` returns null and the toggle does not
 * render. A key in a git history is not a key, and the only safe assumption is
 * that these are already compromised.
 */
export type TestRole = "seller" | "buyer" | "admin";

const SECRETS: Record<TestRole, number[]> = {
  seller: [77, 191, 172, 7, 191, 162, 97, 7, 235, 239, 112, 49, 11, 238, 84, 50, 159, 63, 12, 9, 95, 228, 236, 66, 197, 59, 233, 34, 148, 89, 64, 124, 114, 218, 149, 43, 49, 120, 184, 46, 53, 142, 227, 137, 112, 166, 137, 186, 242, 52, 96, 37, 108, 58, 19, 182, 101, 50, 84, 130, 243, 146, 243, 187],
  admin: [189, 233, 7, 227, 151, 173, 94, 254, 59, 171, 180, 252, 68, 65, 140, 186, 94, 91, 130, 80, 34, 213, 50, 251, 201, 222, 2, 109, 134, 220, 18, 227, 13, 66, 195, 196, 219, 196, 223, 220, 7, 147, 103, 44, 177, 234, 134, 69, 94, 23, 49, 253, 70, 252, 222, 110, 225, 197, 239, 0, 251, 251, 252, 208],
  buyer: [29, 128, 128, 223, 249, 125, 213, 136, 106, 128, 35, 215, 67, 13, 181, 174, 95, 111, 145, 115, 174, 75, 132, 35, 43, 220, 125, 137, 247, 121, 193, 9, 0, 111, 15, 189, 67, 120, 17, 135, 179, 28, 76, 114, 46, 174, 171, 144, 207, 20, 38, 158, 251, 73, 44, 142, 51, 130, 151, 221, 109, 68, 208, 151],
};

/**
 * Enabled only by the exact Devnet build target. The application tree is
 * mounted only after `NetworkBoundary` verifies the Devnet genesis hash, so a
 * label typo or a Mainnet RPC can never expose these public signing keys.
 */
export function testWalletsEnabled(): boolean {
  return IS_DEVNET;
}

export function testKeypair(role: TestRole): Keypair | null {
  if (!testWalletsEnabled()) return null;
  return Keypair.fromSecretKey(Uint8Array.from(SECRETS[role]));
}

export const TEST_ADDRESSES: Record<TestRole, string> = {
  seller: "8jLo1GkfgViEf5ptfACdNP47xioREfFcg3Bz36uAEmAi",
  buyer: "12hDxJowXTSJBDCGTJXejA551otZomokdzkVbRL8okgv",
  admin: "tmM8kECJyA5DtAqUwuwMk2Xuheqk5b18ckbCrhSUBSw",
};

/**
 * The registry admin, which is a different person from either trader.
 *
 * `seller` held the factory admin until now, which made the two impossible to
 * tell apart: the same chip both locked stock and approved collateral, so no
 * arrangement of the UI could show what an ordinary user actually sees. The
 * authority moved to its own key, and `create-panel` shows its sections for
 * this role and no other.
 */
export const ADMIN_ROLE: TestRole = "admin";

/** Roles a person trades with, as opposed to administers the registry with. */
export const USER_ROLES: TestRole[] = ["seller", "buyer"];
