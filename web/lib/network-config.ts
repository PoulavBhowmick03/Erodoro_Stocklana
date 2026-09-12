/**
 * The build target is a security boundary, not a badge.
 *
 * Public environment variables are frozen into the static export. The RPC is
 * verified against the expected genesis hash at runtime before the application
 * tree (and therefore any signing surface) is mounted.
 */
export type ErodoroNetwork = "devnet" | "mainnet-beta";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export type NetworkDefinition = {
  network: ErodoroNetwork;
  label: "devnet" | "mainnet";
  genesisHash: string;
  defaultRpc: string;
  demoCapabilities: boolean;
};

export const NETWORKS: Record<ErodoroNetwork, NetworkDefinition> = {
  devnet: {
    network: "devnet",
    label: "devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    defaultRpc: "https://api.devnet.solana.com",
    demoCapabilities: true,
  },
  "mainnet-beta": {
    network: "mainnet-beta",
    label: "mainnet",
    genesisHash: MAINNET_GENESIS_HASH,
    defaultRpc: "https://api.mainnet-beta.solana.com",
    demoCapabilities: false,
  },
};

export function parseNetwork(value: string | undefined): ErodoroNetwork {
  const normalized = (value || "devnet").trim().toLowerCase();
  if (normalized === "devnet") return "devnet";
  if (normalized === "mainnet" || normalized === "mainnet-beta") return "mainnet-beta";
  throw new Error(
    `Unsupported Erodoro network "${value}". Expected devnet or mainnet-beta.`,
  );
}

export const ACTIVE_NETWORK = parseNetwork(
  process.env.NEXT_PUBLIC_NETWORK || process.env.NEXT_PUBLIC_CLUSTER,
);
export const NETWORK = NETWORKS[ACTIVE_NETWORK];
export const IS_DEVNET = NETWORK.demoCapabilities;

/**
 * The deployed devnet build uses a same-origin Worker route. Helius stays in a
 * Cloudflare secret and never becomes a NEXT_PUBLIC value in the browser
 * bundle. Local devnet development starts on the public endpoint and can fail
 * over to this proxy without learning the provider credential.
 */
export const CLOUDFLARE_DEVNET_RPC =
  "https://erodoro-protocol.hypersettle.workers.dev/rpc";
export const RPC_URL =
  IS_DEVNET
    ? process.env.NODE_ENV === "production"
      ? CLOUDFLARE_DEVNET_RPC
      : NETWORK.defaultRpc
    : process.env.NEXT_PUBLIC_MAINNET_RPC_URL || NETWORK.defaultRpc;
export const RPC_FALLBACK_URL =
  IS_DEVNET && process.env.NODE_ENV !== "production"
    ? CLOUDFLARE_DEVNET_RPC
    : undefined;
export const USES_PUBLIC_RPC_FALLBACK = RPC_URL === NETWORK.defaultRpc;
export const EPHEMERAL_RPC_URL =
  process.env.NEXT_PUBLIC_EPHEMERAL_RPC_URL ||
  (IS_DEVNET ? "https://devnet.magicblock.app" : "");

export function genesisMatches(network: ErodoroNetwork, actual: string): boolean {
  return NETWORKS[network].genesisHash === actual;
}

/** Pure helper used by build tooling and regression tests. */
export function validatePublicNetworkConfig(input: {
  network?: string;
  rpcUrl?: string;
  ephemeralRpcUrl?: string;
}): string[] {
  const errors: string[] = [];
  let network: ErodoroNetwork;
  try {
    network = parseNetwork(input.network);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  if (network === "mainnet-beta") {
    if (!input.rpcUrl?.trim()) errors.push("Mainnet requires NEXT_PUBLIC_MAINNET_RPC_URL.");
    if (!input.ephemeralRpcUrl?.trim()) {
      errors.push("Mainnet requires NEXT_PUBLIC_EPHEMERAL_RPC_URL.");
    }
  }
  return errors;
}
