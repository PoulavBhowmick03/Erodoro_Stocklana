export type IssuerAsset = {
  mint: string;
  symbol: string;
  name: string;
  issuer: string;
  productUrl?: string;
  corporateActionsUrl?: string;
};

/**
 * Issuer-specific discovery and operations live outside the on-chain programs.
 * The factory remains the authority that decides which exact mint and oracle
 * are canonical for a listed series.
 */
export interface IssuerAdapter {
  id: string;
  label: string;
  asset(mint: string): IssuerAsset | null;
  listedAssets(): readonly IssuerAsset[];
}
