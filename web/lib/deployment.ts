import { PublicKey } from "@solana/web3.js";
import { IS_DEVNET } from "./network-config";

/**
 * The one quote asset shared by every listed market on the active deployment.
 *
 * A market identity cannot depend on a browser's localStorage: two visitors
 * choosing different quote mints would derive different Manifest PDAs and see
 * different books. New deployments may override this at build time, while the
 * checked default remains the funded Erodoro devnet fixture.
 */
const DEVNET_DEMO_USDC = "HF8CvJ8afuhvRDiwujtaxH6X863sJNrAtzhAty51sDAa";
const MAINNET_CIRCLE_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const QUOTE_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_QUOTE_MINT ||
    (IS_DEVNET ? DEVNET_DEMO_USDC : MAINNET_CIRCLE_USDC),
);
