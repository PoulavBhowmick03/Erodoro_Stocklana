# Known limitations

Last reviewed: 2026-08-22

This document records what Erodoro does **not** currently promise. The interface
keeps these gaps visible instead of filling them with simulated activity.

## Deployment and assets

- The public application is a **devnet preview**, is **unaudited**, and must not
  be used with assets that represent real value.
- SOL-linked demo collateral and demo USDC are valueless Token-2022 test assets.
  They are not SOL, issued securities, or real stablecoins.
- Devnet terms are internally explicit: the demo collateral payoff is linked to
  SOL/USD. The trading interface reads the live SOL/USD Pyth Lazer account on
  MagicBlock, while expiry settlement uses the approved Pyth SOL/USD account on
  Solana. This is not an equity-price feed or an issuer integration.
- MagicBlock's current public Pyth Lazer feed list covers crypto assets, not the
  issuer equity feeds Erodoro will need on Mainnet. Every production collateral
  mint therefore still requires an approved issuer-to-oracle mapping.
- Mainnet remains disabled until an issuer asset, matching oracle, production
  RPCs, multisig authorities, audit, and deployed program addresses pass the
  release gates in `mainnet-promotion.md`.

## Trading and MagicBlock

- Order placement, filling, and cancellation are intentionally routed only to
  MagicBlock. There is no silent Solana fallback for mutations.
- Public commit-and-undelegate is verified-live on devnet as of 2026-09-12:
  the fee-vault-forwarding Manifest fork build was deployed, the public ER
  re-cloned it, and a pre-existing session plus a fresh full lifecycle both
  exited with exact L1 conservation. Two caveats travel with that result:
  seats must be claimed on L1 *before* delegation (post-activation claims
  regressed out of the deployed build), and active-session seat exhaustion
  plus cross-validator markets remain open.
- Empty books are real empty books. The interface does not seed fake orders,
  spreads, fills, premium, or volume.

## Market data

- `24h volume` is shown as `—` because Manifest market accounts do not provide a
  durable 24-hour fill aggregate. A trade-history indexer is required.
- The price chart is an **indicative midpoint** built from live bid and ask
  observations during the current browser session. It is not historical trade
  data and resets when the page is reloaded.
- The market directory currently reads each listed market from RPC and refreshes
  book quotes per row. This is acceptable for a small devnet registry but needs
  batching or an indexer before the list grows materially.
- The deployed devnet interface sends Solana JSON-RPC through a same-origin
  Cloudflare Worker backed by Helius. The API credential is a Worker secret and
  is not included in the browser bundle. Provider quotas still apply; sustained
  public traffic needs Cloudflare rate limiting and Helius capacity monitoring.
- Local devnet development starts on Solana's public endpoint. A `429`, a
  temporary `5xx`, or a transport failure switches reads and transactions to
  the Cloudflare-backed Helius endpoint for a short cooldown. Both providers
  can still be unavailable at the same time.

## Product operations

- “Request early access” currently opens a prefilled GitHub issue. There is no
  dedicated private-access intake service yet.
- Wallets are discovered through Solana Wallet Standard. An extension that
  advertises a Solana connector but cannot initialize may fail to connect; the
  market remains readable and the selection resets instead of breaking the
  page.
