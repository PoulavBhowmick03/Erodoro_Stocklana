# Manifest + MagicBlock feasibility spike

Tested on Solana devnet and the public MagicBlock devnet on 2026-08-17.

## Pinned inputs

- `@bonasa-tech/manifest-sdk@0.2.44`
- `@magicblock-labs/ephemeral-rollups-sdk@0.16.1`
- Manifest program: `MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms`
- Ephemeral SPL program: `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`
- MagicBlock devnet validator: `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`

The source trees inspected for the spike were Manifest commit
`08b0e7197f1ce3178ee00ff873ed6d7b84beb7cb` and ephemeral-spl-token commit
`c60bb40afb2bcb1892fdf916d0f2d9c22b98b8f1`.

## What the live test proves

Run:

```sh
pnpm devnet:manifest-ephemeral
```

The test creates disposable classic SPL mints and accounts, then proves:

1. Native SPL balances can be deposited into ephemeral-spl-token and delegated
   to the public MagicBlock devnet.
2. MagicBlock projects each delegated balance at its normal associated-token
   address.
3. An ordinary SPL Token (`Tokenkeg`) transfer moves value between those
   projected accounts inside the ephemeral rollup.
4. Both owners can withdraw the resulting balances to Solana again.
5. Stock Manifest creates a market, accepts a deposit from the same canonical
   ATA shape, and places a real order on Solana devnet.

## Boundary found by the live test

The two deployed programs are compatible at the token-account interface, but
they are not a zero-change end-to-end composition.

- A stock Manifest core `BatchUpdate` sent to MagicBlock is rejected with
  `Transaction loads a writable account that cannot be written` because its
  market account is not delegated.
- Directly calling the MagicBlock delegation program, even while retaining and
  signing with Manifest's market keypair, is rejected with
  `Invalid account owner`.
- The owning Manifest program must expose the ownership handoff/delegation
  instruction. Stock Manifest currently does not.

This means “Manifest as a starting point together with ephemeral-spl-token” is
a viable fork/adaptation plan, not a configuration-only integration with the
currently deployed Manifest program.

## Implementation plan

1. Fork the Manifest **core** program and SDK at the pinned revision. Do not use
   its wrapper account on the hot path; core `BatchUpdate` needs only the trader
   signer and one writable market account for ordinary limit orders.
2. Add `delegate_market`, `commit_market`, and `undelegate_market` instructions
   to the owning program using MagicBlock's delegation lifecycle. Preserve
   Manifest's market layout and matching logic so its existing property tests
   remain useful.
3. Decide the custody boundary before changing vaults:
   - First milestone: fund Manifest balances and vaults on Solana, delegate only
     the market for a trading session, then commit/undelegate before deposits or
     withdrawals. This is the smallest path to a proven Manifest order book.
   - Full ephemeral-SPL milestone: change each market vault to the projected
     canonical ATA of a Manifest-controlled vault-authority PDA. Delegate the
     trader eATAs and both vault eATAs to the same validator, then perform
     deposit/withdraw transfers through normal SPL instructions in the rollup.
4. Add session invariants: one selected validator, no L1 balance mutations
   while the market is delegated, vault totals equal internal trader balances,
   and an emergency commit/undelegate path.
5. Port the current UI from order-ID fills to Manifest bids/asks, price-time
   crossing, cancel-by-sequence-number, and market-maker quoting. Keep the
   classic order-book panel and label the ephemeral execution surfaces
   `(powered by MagicBlock)`.
6. Gate deployment on an end-to-end test that performs: e-token deposit,
   market/vault delegation, maker order, taker match, cancel, commit,
   undelegate, and withdrawal with exact balance conservation.

## Licensing and deployment note

Manifest is GPL-3.0 while this repository is Apache-2.0. Copying or modifying
the program here requires an explicit licensing decision. A separately
maintained GPL fork with its own deployed program ID is the cleanest technical
boundary. That custom program also needs to be available on the target
MagicBlock validator before the end-to-end milestone can run.
