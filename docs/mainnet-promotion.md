# Devnet to Mainnet promotion

Erodoro has one protocol and application codebase. `main` is the integration
branch deployed to Devnet; `mainnet` is a protected promotion pointer to an
already verified commit. Product work must not be implemented directly on the
`mainnet` branch.

## Environment boundary

The build target selects deployment data, never alternate contract logic.

| Capability | Devnet | Mainnet |
| --- | --- | --- |
| Series, factory and oracle code | Shared | Shared |
| P/N and Manifest trading flow | Shared | Shared |
| Collateral | Valueless issuer-shaped mint | Multisig-approved issuer mint |
| Quote | Demo classic-SPL token | Circle USDC |
| Test signing keys | Enabled after Devnet genesis verification | Compiled out |
| Demo minting and browser bootstrap | Enabled | Compiled out |
| Listings | Test administrator | Reviewed multisig transaction |

The application calls `getGenesisHash` before mounting wallet state. A mismatch
between the build target and RPC blocks reads and every mutation. Mainnet has no
implicit RPC or MagicBlock endpoint, and its prebuild fails when production
addresses are absent.

## Issuer boundary

Issuer support is an adapter plus an on-chain approval, not a fork of the Rust
programs. Devnet selects `demoIssuer`; Mainnet selects `backedXstocksIssuer`.
The adapter supplies canonical display and operational metadata. The factory
multisig still decides which exact mint and oracle appear in discovery.

The first candidate is Backed's real Solana TSLAx mint
`XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`. Candidate status is not approval.
Before listing it, run the live mint preflight, approve a production settlement
feed, resolve the dividend policy, and obtain issuer and legal review.

## Promotion procedure

1. Merge a feature into `main`.
2. Build the programs and run `pnpm check:program-artifacts` when the change is
   declared frontend/configuration-only.
3. Run native, validator, browser, Devnet invariant, Manifest and MagicBlock
   lifecycle suites as appropriate.
4. Deploy the exact commit to Devnet and complete the release checklist.
5. Open a promotion PR from `main` to `mainnet`; do not cherry-pick or rewrite.
6. Build Mainnet using reviewed values based on `web/.env.mainnet.example`.
7. Confirm genesis, program executability, mint owners, oracle configuration,
   upgrade authorities and artifact hashes.
8. Require a human deployment approval, tag the commit, then deploy.

Any emergency change made from `mainnet` must be merged back into `main` before
the next feature is accepted.

## Mainnet release gates

- External audit covers series, oracle, Manifest custody additions and browser
  transaction construction.
- The canonical ephemeral-SPL fee-vault exit path is deployed and pinned.
- A permissionless maturity cancel/exit path is available.
- Program upgrade authorities are held by the reviewed multisig or finalized.
- The issuer mint and corporate-action policy are approved.
- Production oracle identity, freshness and confidence policy are approved.
- Monitoring, incident response and initial TVL caps are active.
- A counterparty or market maker is committed to quote N.
