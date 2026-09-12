"use client";

import type { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTestWallet } from "@/components/test-wallet";

/**
 * The key that will actually sign, whichever source it came from.
 *
 * Every panel gates its controls on "is there a signer", and reading that from
 * `useWallet` alone was wrong the moment test keys existed: picking one filled
 * the header but left the panels believing nobody was connected, so the
 * buttons stayed hidden and the toggle looked broken rather than unfinished.
 *
 * A test key takes precedence over a connected wallet, matching `useSend`,
 * which signs with the test keypair when one is selected. The address a panel
 * shows and the address that signs have to be the same address.
 */
export function useSigner(): PublicKey | null {
  const { publicKey: walletKey } = useWallet();
  const { publicKey: testKey } = useTestWallet();
  return testKey ?? walletKey;
}
