import type { IssuerAdapter } from "./types";

export const demoIssuer: IssuerAdapter = {
  id: "demo",
  label: "Erodoro demo issuer",
  asset: () => null,
  listedAssets: () => [],
};
