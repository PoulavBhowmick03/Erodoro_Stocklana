import type { IssuerAdapter, IssuerAsset } from "./types";

/**
 * First production candidate. This is the real Solana TSLAx mint published by
 * Backed Assets (JE) Limited, not a demo alias. Adding an asset here does not
 * list it: the Mainnet factory multisig must still approve the exact mint and
 * settlement feed on chain.
 */
const ASSETS: readonly IssuerAsset[] = [
  {
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    symbol: "TSLAx",
    name: "Tesla xStock",
    issuer: "Backed Assets (JE) Limited",
    productUrl: "https://assets.backed.fi/products/tesla-xstock",
    corporateActionsUrl: "https://api.backed.fi/api-docs/",
  },
] as const;

const BY_MINT = new Map(ASSETS.map((asset) => [asset.mint, asset]));

export const backedXstocksIssuer: IssuerAdapter = {
  id: "backed-xstocks",
  label: "Backed xStocks",
  asset: (mint) => BY_MINT.get(mint) ?? null,
  listedAssets: () => ASSETS,
};
