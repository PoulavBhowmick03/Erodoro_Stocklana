import { IS_DEVNET } from "../network-config";
import { backedXstocksIssuer } from "./backed-xstocks";
import { demoIssuer } from "./demo";

export type { IssuerAdapter, IssuerAsset } from "./types";

export const ACTIVE_ISSUER = IS_DEVNET ? demoIssuer : backedXstocksIssuer;
