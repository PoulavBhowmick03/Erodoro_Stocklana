"use client";

import { BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  LEG,
  type LegName,
  approvedCollateralPda,
  approvedOraclePda,
  bookPda,
  factoryPda,
  feedConfigPda,
  marketPda,
  nMintPda,
  pMintPda,
  recordPda,
  seriesPda,
  settlementPda,
} from "./pdas";
import { EPHEMERAL_RPC_URL } from "./network-config";

/**
 * Every transaction the app can send.
 *
 * The `methods` builders are cast to `any` at each call site: Anchor resolves
 * account names into a deep conditional type from the IDL, and against an
 * untyped `Program` that exceeds TypeScript's instantiation depth. The account
 * maps below are still checked against the programs by the integration tests,
 * which is where a wrong name would actually show up.
 *
 * Two token programs are in play and mixing them is the easiest way to build a
 * silently wrong instruction: the **collateral is Token-2022**, while **P, N
 * and the quote mint are classic SPL Token**. The helpers below are the only
 * places that choose, so no component has to remember.
 */

export const collateralAta = (mint: PublicKey, owner: PublicKey, allowOwnerOffCurve = false) =>
  getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, TOKEN_2022_PROGRAM_ID);

export const claimAta = (mint: PublicKey, owner: PublicKey, allowOwnerOffCurve = false) =>
  getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, TOKEN_PROGRAM_ID);

/** Create an associated token account if the wallet does not have one yet. */
function ensureAta(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): { address: PublicKey; ix: TransactionInstruction } {
  const address = getAssociatedTokenAddressSync(mint, owner, false, programId);
  return {
    address,
    // Idempotent: safe to include even when the account already exists, which
    // keeps the caller from needing a round-trip to find out.
    ix: createAssociatedTokenAccountIdempotentInstruction(
      payer,
      address,
      owner,
      mint,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  };
}

// --- series ---------------------------------------------------------------

type SeriesCtx = {
  series: Program<any>;
  address: PublicKey;
  config: any;
  wallet: PublicKey;
};

/**
 * Lock collateral and mint equal P and N.
 *
 * `feeVault` is null because V1 charges no fee. If `fee_bps` is ever non-zero
 * the fee recipient's collateral account has to be passed instead.
 */
export async function splitIx({ series, address, config, wallet }: SeriesCtx, amount: BN) {
  const p = ensureAta(wallet, wallet, pMintPda(address), TOKEN_PROGRAM_ID);
  const n = ensureAta(wallet, wallet, nMintPda(address), TOKEN_PROGRAM_ID);

  const ix = await (series.methods as any)
    .split(amount)
    .accounts({
      holder: wallet,
      series: address,
      collateralMint: config.collateralMint,
      collateralVault: config.collateralVault,
      holderCollateral: collateralAta(config.collateralMint, wallet),
      pMint: pMintPda(address),
      nMint: nMintPda(address),
      receiverP: p.address,
      receiverN: n.address,
      feeVault: null,
      collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return [p.ix, n.ix, ix];
}

/** Burn equal P and N and take the collateral back. Works while paused. */
export async function mergeIx({ series, address, config, wallet }: SeriesCtx, amount: BN) {
  const ix = await (series.methods as any)
    .merge(amount)
    .accounts({
      holder: wallet,
      series: address,
      collateralMint: config.collateralMint,
      collateralVault: config.collateralVault,
      holderCollateral: collateralAta(config.collateralMint, wallet),
      pMint: pMintPda(address),
      nMint: nMintPda(address),
      holderP: claimAta(pMintPda(address), wallet),
      holderN: claimAta(nMintPda(address), wallet),
      collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [ix];
}

/** Redeem one side against the frozen pool. */
export async function redeemIx(
  { series, address, config, wallet }: SeriesCtx,
  side: LegName,
  amount: BN,
) {
  const mint = side === "P" ? pMintPda(address) : nMintPda(address);
  const common = {
    holder: wallet,
    series: address,
    settlement: settlementPda(address),
    collateralMint: config.collateralMint,
    collateralVault: config.collateralVault,
    holderCollateral: collateralAta(config.collateralMint, wallet),
    collateralTokenProgram: TOKEN_2022_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
  };

  const ix =
    side === "P"
      ? await (series.methods as any)
          .redeemP(amount)
          .accounts({ ...common, pMint: mint, holderP: claimAta(mint, wallet) })
          .instruction()
      : await (series.methods as any)
          .redeemN(amount)
          .accounts({ ...common, nMint: mint, holderN: claimAta(mint, wallet) })
          .instruction();
  return [ix];
}

/**
 * Settlement is permissionless — anyone can poke it, and nobody can choose the
 * price. The UI can offer it to any visitor once a series has matured.
 */
export async function settleIx(
  { series, address, config, wallet }: SeriesCtx,
  priceSource: PublicKey,
) {
  const ix = await (series.methods as any)
    .settle()
    .accounts({
      payer: wallet,
      series: address,
      settlement: settlementPda(address),
      collateralMint: config.collateralMint,
      collateralVault: config.collateralVault,
      pMint: pMintPda(address),
      nMint: nMintPda(address),
      oracleAdapter: config.oracleAdapter,
      priceSource,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return [ix];
}

// --- order book -----------------------------------------------------------

type BookCtx = {
  market: Program<any>;
  seriesAddress: PublicKey;
  marketAccount: any;
  leg: LegName;
  wallet: PublicKey;
};

const baseMintOf = (m: any, leg: LegName) => (leg === "P" ? m.pMint : m.nMint);
const baseVaultOf = (m: any, leg: LegName) => (leg === "P" ? m.pVault : m.nVault);

function bookAccounts({ seriesAddress, marketAccount, leg, wallet }: BookCtx) {
  const market = marketPda(seriesAddress);
  return {
    trader: wallet,
    market,
    book: bookPda(market, leg),
    baseVault: baseVaultOf(marketAccount, leg),
    quoteVault: marketAccount.quoteVault,
    traderBase: claimAta(baseMintOf(marketAccount, leg), wallet),
    traderQuote: claimAta(marketAccount.quoteMint, wallet),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

/** Move P/N and quote into the vaults and credit the trader's slot. L1 only. */
export async function depositIx(ctx: BookCtx, base: BN, quote: BN) {
  const base_ = ensureAta(ctx.wallet, ctx.wallet, baseMintOf(ctx.marketAccount, ctx.leg), TOKEN_PROGRAM_ID);
  const quote_ = ensureAta(ctx.wallet, ctx.wallet, ctx.marketAccount.quoteMint, TOKEN_PROGRAM_ID);
  const ix = await (ctx.market.methods as any)
    .deposit(base, quote)
    .accounts(bookAccounts(ctx))
    .instruction();
  return [base_.ix, quote_.ix, ix];
}

/** Take unlocked balance back out. Resting orders hold the rest. */
export async function withdrawIx(ctx: BookCtx, base: BN, quote: BN) {
  const ix = await (ctx.market.methods as any)
    .withdraw(base, quote)
    .accounts(bookAccounts(ctx))
    .instruction();
  return [ix];
}

/**
 * Rest a limit order. Runs on L1 or inside a rollup session — the instruction
 * is identical either way, which is the point of keeping tokens out of it.
 *
 * `price` is quote units per whole unit of base.
 */
export async function placeOrderIx(ctx: BookCtx, isBid: boolean, price: BN, qty: BN) {
  const market = marketPda(ctx.seriesAddress);
  const ix = await (ctx.market.methods as any)
    .placeOrder(isBid, price, qty)
    .accounts({ trader: ctx.wallet, market, book: bookPda(market, ctx.leg) })
    .instruction();
  return [ix];
}

export async function cancelOrderIx(ctx: BookCtx, id: BN) {
  const market = marketPda(ctx.seriesAddress);
  const ix = await (ctx.market.methods as any)
    .cancelOrder(id)
    .accounts({ trader: ctx.wallet, market, book: bookPda(market, ctx.leg) })
    .instruction();
  return [ix];
}

/** Cross against a resting order, at the maker's price. */
export async function fillOrderIx(ctx: BookCtx, id: BN, qty: BN) {
  const market = marketPda(ctx.seriesAddress);
  const ix = await (ctx.market.methods as any)
    .fillOrder(id, qty)
    .accounts({ trader: ctx.wallet, market, book: bookPda(market, ctx.leg) })
    .instruction();
  return [ix];
}

/**
 * Turn a program error into something a person can act on.
 *
 * The two worth special-casing are the ones a correct client still hits: a
 * book that is mid-rollup-session (its owner is the delegation program, so L1
 * instructions bounce), and a series past maturity.
 */
export function explainError(e: unknown): string {
  const s = String(e);
  if (/AccountOwnedByWrongProgram|owner constraint|3007/i.test(s)) {
    return "Live execution (powered by MagicBlock) is active, so this legacy book cannot move L1 balances. Use operator diagnostics for emergency settlement first.";
  }
  if (/MarketClosed/i.test(s)) return "This series is over. P and N can be cashed out now, not traded.";
  if (/InsufficientBalance/i.test(s)) return "Not enough free balance. Cancel an open order to free some up.";
  if (/AlreadySettled/i.test(s)) return "This series has already settled.";
  if (/SeriesNotMatured|SettlementTooEarly/i.test(s)) return "Too early. This series has not reached its date yet.";
  if (/NotOrderOwner/i.test(s)) return "That order belongs to someone else.";
  if (/SelfFill/i.test(s)) return "You cannot fill your own order.";
  // Anchor renders this one as "A has one constraint was violated", which tells
  // the reader nothing. On this app every `has_one` is the factory's admin, so
  // the useful translation is the identity mismatch it always means.
  if (/ConstraintHasOne|constraint was violated|\b2001\b/i.test(s)) {
    return (
      "The key you are signing with is not the registry admin. Approving a price feed " +
      "or a token, and creating a listed contract, can only be done by the key that set " +
      "the registry up."
    );
  }
  if (/User rejected|rejected the request/i.test(s)) return "You rejected it in the wallet.";
  // The SPL Token program's own wording, which means the *token* account is
  // short — not SOL. Distinguished before the lamports case below, because
  // "insufficient funds" matches both and the two have different remedies.
  if (/Program log: Error: insufficient funds/i.test(s)) {
    return (
      "Not enough of that token in this wallet. Check the balances above — you can only " +
      "move what you actually hold, and locking collateral is what mints P and N in the " +
      "first place."
    );
  }
  if (/insufficient lamports/i.test(s)) return "Not enough SOL to pay for this transaction.";
  if (/insufficient funds/i.test(s)) return "Not enough SOL to pay for this transaction.";
  const anchor = s.match(/Error Message: ([^.]+)\./);
  if (anchor) return anchor[1];
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

// --- rollup sessions ------------------------------------------------------
//
// Three instructions the app never called. `delegate_book` runs on L1 — it is
// what hands the account to the delegation program. `commit_book` and
// `undelegate_book` run on the *rollup*, because that is where the state being
// committed lives; sending them to L1 finds a book it no longer owns.

/**
 * The rollup validator the delegation names.
 *
 * A delegation is to a specific validator, not to "the rollup" in general, so
 * this has to match the one actually serving `NEXT_PUBLIC_EPHEMERAL_RPC_URL`.
 * When it does not, the book is delegated to a validator that is not the one
 * the app then talks to: the endpoint does not hold the delegation, so it sees
 * a write to an account it does not own and rejects every order with
 * `InvalidWritableAccount`. Deposits still work, because those are L1, which
 * makes the failure look like a trading bug rather than a routing one.
 *
 * `mAGicPQY…` is the local `mb-stack` identity used by
 * `tests/rollup-session.ts`; the hosted devnet endpoint is a different one. So
 * this is resolved from the endpoint itself rather than assumed, and the env
 * var is an override for when a specific validator is wanted.
 */
export async function rollupValidator(): Promise<PublicKey> {
  const override = process.env.NEXT_PUBLIC_ROLLUP_VALIDATOR;
  const expected = override ? new PublicKey(override) : null;
  const endpoint = EPHEMERAL_RPC_URL;
  if (!endpoint) throw new Error("This deployment has no configured MagicBlock RPC.");
  try {
    const res = await fetch(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const id = (await res.json())?.result?.identity;
    if (id) {
      const actual = new PublicKey(id);
      if (expected && !actual.equals(expected)) {
        throw new Error(
          `validator identity ${actual.toBase58()} does not match configured ${expected.toBase58()}`,
        );
      }
      return actual;
    }
    throw new Error("getIdentity returned no validator");
  } catch (error) {
    throw new Error(
      `Could not verify the MagicBlock validator at ${endpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Hand the book to the delegation program. Sent on L1. */
export async function delegateBookIx(ctx: BookCtx) {
  const validator = await rollupValidator();
  return [
    await (ctx.market.methods as any)
      .delegateBook(LEG[ctx.leg].arg)
      .accounts({
        payer: ctx.wallet,
        market: marketPda(ctx.seriesAddress),
        book: bookPda(marketPda(ctx.seriesAddress), ctx.leg),
      })
      // The validator to delegate to is read from remaining_accounts.
      .remainingAccounts([
        { pubkey: validator, isSigner: false, isWritable: false },
      ])
      .instruction(),
  ];
}

/**
 * Checkpoint rollup state back to L1 without ending the session. Sent on the
 * rollup.
 *
 * Worth doing periodically rather than only at the end: everything since the
 * last commit is what a validator failure would cost.
 */
export async function commitBookIx(ctx: BookCtx) {
  return [
    await (ctx.market.methods as any)
      .commitBook()
      .accounts({
        payer: ctx.wallet,
        book: bookPda(marketPda(ctx.seriesAddress), ctx.leg),
      })
      .instruction(),
  ];
}

/**
 * End the session and hand ownership back. Sent on the rollup.
 *
 * Lands asynchronously — the rollup commits, then the delegation program
 * returns the account — so L1 ownership does not flip in the same breath as
 * the transaction confirming.
 */
export async function undelegateBookIx(ctx: BookCtx) {
  return [
    await (ctx.market.methods as any)
      .undelegateBook()
      .accounts({
        payer: ctx.wallet,
        book: bookPda(marketPda(ctx.seriesAddress), ctx.leg),
      })
      .instruction(),
  ];
}

// --- bringing a series into existence ------------------------------------
//
// Five steps, and the order is forced by the program rather than chosen:
// the factory must exist before it can approve anything, a feed config must
// exist before it can be approved, and `create_series` takes both approval
// PDAs as accounts -- their existence *is* the permission.

type FactoryCtx = { factory: Program<any>; wallet: PublicKey };

/** One-time. Whoever calls this becomes the factory admin. */
export async function initFactoryIx(ctx: FactoryCtx) {
  return [
    await (ctx.factory.methods as any)
      .initialize()
      .accounts({ payer: ctx.wallet, admin: ctx.wallet, factory: factoryPda() })
      .instruction(),
  ];
}

/**
 * Pin a Pyth feed behind a config account this program owns.
 *
 * `feedId` is the quote's own identity, checked on every read, which is what
 * makes rotating the *source account* safe later. `minVerificationSignatures`
 * of 0 accepts an update backed by no guardian signatures at all -- fine on
 * devnet against a sponsored feed, never on mainnet.
 */
export async function initFeedConfigIx(
  oracle: Program<any>,
  wallet: PublicKey,
  feedId: Uint8Array,
  source: PublicKey,
  maxAgeSecs: BN,
  minVerificationSignatures: number,
) {
  return [
    await (oracle.methods as any)
      .initializeFeedConfig(Array.from(feedId), maxAgeSecs, minVerificationSignatures)
      .accounts({
        payer: wallet,
        admin: wallet,
        feedConfig: feedConfigPda(feedId),
        source,
      })
      .instruction(),
  ];
}

export async function approveOracleIx(ctx: FactoryCtx, feedConfig: PublicKey) {
  return [
    await (ctx.factory.methods as any)
      .approveOracle()
      .accounts({
        payer: ctx.wallet,
        admin: ctx.wallet,
        factory: factoryPda(),
        feedConfig,
        approval: approvedOraclePda(feedConfig),
      })
      .instruction(),
  ];
}

export async function approveCollateralIx(ctx: FactoryCtx, mint: PublicKey) {
  return [
    await (ctx.factory.methods as any)
      .approveCollateral()
      .accounts({
        payer: ctx.wallet,
        admin: ctx.wallet,
        factory: factoryPda(),
        collateralMint: mint,
        approval: approvedCollateralPda(mint),
      })
      .instruction(),
  ];
}

export type CreateSeriesInput = {
  strike: BN;
  maturityTs: BN;
  priceDecimals: number;
  settlementDelaySecs: BN;
  maxOracleAgeSecs: BN;
  maxPriceLagSecs: BN;
  minSplitAmount: BN;
  feeBps: number;
};

/**
 * Deploy a whole series: the config, its vault, both claim mints, and the
 * registry record that makes it canonical.
 *
 * The series address is seeded on the *creator* as well as the parameters.
 * Creation is permissionless, so without that anyone could occupy the address
 * the factory was about to use and block the canonical series for good.
 */
export async function createSeriesIx(
  ctx: FactoryCtx,
  seriesProgramId: PublicKey,
  collateralMint: PublicKey,
  collateralTokenProgram: PublicKey,
  feedConfig: PublicKey,
  input: CreateSeriesInput,
) {
  const factory = factoryPda();
  const series = seriesPda(factory, collateralMint, input.strike, input.maturityTs);

  return [
    await (ctx.factory.methods as any)
      .createSeries(input)
      .accounts({
        payer: ctx.wallet,
        admin: ctx.wallet,
        factory,
        seriesAdmin: ctx.wallet,
        oracleApproval: approvedOraclePda(feedConfig),
        collateralApproval: approvedCollateralPda(collateralMint),
        feedConfig,
        collateralMint,
        series,
        // The vault is the series' own associated token account, created by
        // `series::create_series`. It has to be passed explicitly: the factory
        // declares it `UncheckedAccount`, so the IDL carries no seeds and
        // Anchor has nothing to derive it from. `allowOwnerOffCurve` because
        // the owner is a PDA, and the collateral's own token program because
        // an ATA address depends on it.
        collateralVault: getAssociatedTokenAddressSync(
          collateralMint,
          series,
          true,
          collateralTokenProgram,
        ),
        pMint: pMintPda(series),
        nMint: nMintPda(series),
        feeRecipient: ctx.wallet,
        record: recordPda(series),
        seriesProgram: seriesProgramId,
        collateralTokenProgram,
      })
      .instruction(),
  ];
}

// --- opening a market ------------------------------------------------------
//
// Two instructions the client never had, which is why every book rendered "no
// market for this side yet" and the buyer half of the protocol was unreachable
// from the app. The programs have supported both since they were written.

/**
 * Create the market for a series.
 *
 * The market is per series; the books are per leg underneath it. Anchor derives
 * the market PDA and all three vaults (they are associated token accounts of
 * the market), so only the mints have to be named.
 *
 * `quoteMint` must be classic SPL. The vaults are created with the classic
 * token program, and a Token-2022 mint fails the constraint rather than
 * silently producing an unusable market.
 */
export async function initMarketIx(
  ctx: { market: Program<any>; wallet: PublicKey },
  seriesAddress: PublicKey,
  quoteMint: PublicKey,
  maturityTs: BN,
) {
  return [
    await (ctx.market.methods as any)
      .initializeMarket(maturityTs)
      .accounts({
        payer: ctx.wallet,
        series: seriesAddress,
        pMint: pMintPda(seriesAddress),
        nMint: nMintPda(seriesAddress),
        quoteMint,
      })
      .instruction(),
  ];
}

/** Open the book for one leg. Each leg trades separately. */
export async function initBookIx(
  ctx: { market: Program<any>; wallet: PublicKey },
  seriesAddress: PublicKey,
  leg: LegName,
) {
  const market = marketPda(seriesAddress);
  return [
    await (ctx.market.methods as any)
      .initializeBook(LEG[leg].arg)
      .accounts({ payer: ctx.wallet, market, book: bookPda(market, leg) })
      .instruction(),
  ];
}
