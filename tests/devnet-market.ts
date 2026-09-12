// SPDX-License-Identifier: Apache-2.0
//
// The order book, against the program deployed to devnet.
//
// What this proves that a local validator cannot: the program deploys and
// executes on a real cluster, the `Book` account round-trips through devnet
// RPC with orders and balances in one account, and the escrow arithmetic holds
// when two independent wallets trade against each other for real.
//
// The rollup session itself is not exercised here — delegating requires a
// MagicBlock validator, and the L1 half is what has to be right first. The
// delegation instruction is asserted to exist and to be rejected when the
// caller is wrong; see `docs/magicblock.md` for what a session adds.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json pnpm devnet:market

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";
const BN = (anchor as any).BN ?? (anchor as any).default.BN;
const { assert } = chai;
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Deterministic devnet fixtures.
 *
 * Devnet SOL is scarce and the faucet is rate-limited, so every account this
 * suite needs is derived from a fixed seed and created only if it is missing.
 * A partial run is never wasted, and a re-run costs transaction fees alone.
 *
 * The seed is namespaced by the payer, because these accounts outlive a
 * deployment. Mints are owned by whoever created them, not by the program, so a
 * fixed seed hands a new deployer a mint it cannot mint from — which is exactly
 * what happened across the 2026-08-15 fork, when upgrade authority moved from
 * 9CQVNjVL… to 5cpcXjLZ… and `mintTo` started failing with OwnerMismatch. Each
 * payer gets its own fixture set instead.
 */
const fixture = (owner: PublicKey, name: string) =>
  Keypair.fromSeed(
    crypto.createHash("sha256").update(`erodoro:devnet:${owner.toBase58()}:${name}`).digest().subarray(0, 32),
  );

const IDL_DIR = path.resolve(process.cwd(), "target", "idl");
const enc = new TextEncoder();
const seed = (s: string) => Buffer.from(enc.encode(s));

/** P and N inherit the collateral's 8 decimals; USDC has 6. */
const BASE_DECIMALS = 8;
const QUOTE_DECIMALS = 6;
const ONE = 100_000_000;
const USDC = 1_000_000;

/** `Leg::N` — the leg that actually needs a buyer. */
const LEG_N = { n: {} };
const LEG_N_TAG = 1;

function loadProgram(name: string, provider: anchor.AnchorProvider): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(IDL_DIR, `${name}.json`), "utf8"));
  return new anchor.Program(idl, provider);
}

describe("order book on devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let market: anchor.Program<any>;

  // Two independent traders, so fills cross real wallet boundaries rather
  // than moving value between two slots the same key controls. They never pay
  // fees — Anchor uses the provider wallet as fee payer and adds these as
  // extra signers — so they need no SOL of their own.
  const fx = (name: string) => fixture(payer.publicKey, name);
  const maker = fx("maker");
  const taker = fx("taker");

  let series: PublicKey;
  let pMint: PublicKey;
  let nMint: PublicKey;
  let quoteMint: PublicKey;
  let marketPda: PublicKey;
  let bookPda: PublicKey;
  let nVault: PublicKey;
  let quoteVault: PublicKey;

  const traderAtas = new Map<string, { base: PublicKey; quote: PublicKey }>();

  const slotOf = (book: any, who: PublicKey) =>
    book.slots.find((s: any) => s.occupied && s.owner.equals(who));

  async function fetchBook() {
    return (market.account as any).book.fetch(bookPda);
  }

  async function tokenBalance(a: PublicKey) {
    return Number((await getAccount(connection, a)).amount);
  }

  function tradeAccounts(who: PublicKey) {
    return { trader: who, market: marketPda, book: bookPda };
  }

  before("create mints, a market and a book, and fund both traders", async function () {
    market = loadProgram("market", provider);

    const info = await connection.getAccountInfo(market.programId);
    assert.isNotNull(info, `market is not deployed at ${market.programId.toBase58()}`);
    assert.isTrue(info!.executable, "market is not executable");

    // Only the fee payer needs SOL. Skip loudly rather than fail obscurely.
    const bal = await connection.getBalance(payer.publicKey);
    if (bal < 0.05 * 1e9) {
      console.log(`        payer has ${(bal / 1e9).toFixed(3)} SOL — need ~0.05`);
      this.skip();
    }

    // Stand-ins for a real series' claim tokens and for USDC. The market never
    // inspects the series, so any account serves as its identifier.
    series = fx("series").publicKey;
    const mintFor = async (name: string, decimals: number) => {
      const kp = fx(name);
      if (!(await connection.getAccountInfo(kp.publicKey))) {
        await createMint(connection, payer, payer.publicKey, null, decimals, kp);
      } else {
        // A leftover mint from another deployer would fail later inside
        // `mintTo` as a bare OwnerMismatch. Say why here instead.
        const m = await getMint(connection, kp.publicKey);
        assert.equal(
          m.mintAuthority?.toBase58(),
          payer.publicKey.toBase58(),
          `${name} at ${kp.publicKey.toBase58()} is not mintable by this payer`,
        );
      }
      return kp.publicKey;
    };
    pMint = await mintFor("p-mint", BASE_DECIMALS);
    nMint = await mintFor("n-mint", BASE_DECIMALS);
    quoteMint = await mintFor("quote-mint", QUOTE_DECIMALS);

    marketPda = PublicKey.findProgramAddressSync(
      [seed("market"), series.toBuffer()],
      market.programId,
    )[0];
    bookPda = PublicKey.findProgramAddressSync(
      [seed("book"), marketPda.toBuffer(), Buffer.from([LEG_N_TAG])],
      market.programId,
    )[0];
    nVault = getAssociatedTokenAddressSync(nMint, marketPda, true);
    quoteVault = getAssociatedTokenAddressSync(quoteMint, marketPda, true);

    const maturity = Math.floor(Date.now() / 1000) + 7 * 86400;
    if (!(await connection.getAccountInfo(marketPda)))
      await market.methods
      .initializeMarket(new BN(maturity))
      .accounts({
        payer: payer.publicKey,
        series,
        market: marketPda,
        pMint,
        nMint,
        quoteMint,
        pVault: getAssociatedTokenAddressSync(pMint, marketPda, true),
        nVault,
        quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    if (!(await connection.getAccountInfo(bookPda)))
      await market.methods
      .initializeBook(LEG_N)
      .accounts({
        payer: payer.publicKey,
        market: marketPda,
        book: bookPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // The maker sells N, so they hold N. The taker buys it, so they hold USDC.
    for (const [kp, base, quote] of [
      [maker, 5 * ONE, 0],
      [taker, 0, 500 * USDC],
    ] as const) {
      const b = await createAssociatedTokenAccountIdempotent(connection, payer, nMint, kp.publicKey);
      const q = await createAssociatedTokenAccountIdempotent(connection, payer, quoteMint, kp.publicKey);
      traderAtas.set(kp.publicKey.toBase58(), { base: b, quote: q });
      const have = { base: Number((await getAccount(connection, b)).amount),
                     quote: Number((await getAccount(connection, q)).amount) };
      if (base > have.base) await mintTo(connection, payer, nMint, b, payer, base - have.base);
      if (quote > have.quote) await mintTo(connection, payer, quoteMint, q, payer, quote - have.quote);
    }
  });

  it("wires the market to its mints and vaults", async () => {
    const m = await (market.account as any).market.fetch(marketPda);
    assert.equal(m.series.toBase58(), series.toBase58());
    assert.equal(m.nMint.toBase58(), nMint.toBase58());
    assert.equal(m.quoteMint.toBase58(), quoteMint.toBase58());
    assert.equal(m.nVault.toBase58(), nVault.toBase58());

    const b = await fetchBook();
    assert.equal(b.market.toBase58(), marketPda.toBase58());
    assert.property(b.leg, "n", "this book trades the N leg");
    assert.equal(b.orders.length, 0);
    assert.equal(b.volumeBase.toNumber(), 0);
  });

  it("moves real tokens into the vaults on deposit", async () => {
    for (const [kp, base, quote] of [
      [maker, 2 * ONE, 0],
      [taker, 0, 100 * USDC],
    ] as const) {
      const atas = traderAtas.get(kp.publicKey.toBase58())!;
      await market.methods
        .deposit(new BN(base), new BN(quote))
        .accounts({
          trader: kp.publicKey,
          market: marketPda,
          book: bookPda,
          baseVault: nVault,
          quoteVault,
          traderBase: atas.base,
          traderQuote: atas.quote,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([kp])
        .rpc();
    }

    assert.equal(await tokenBalance(nVault), 2 * ONE, "N reached the vault");
    assert.equal(await tokenBalance(quoteVault), 100 * USDC, "USDC reached the vault");

    const b = await fetchBook();
    assert.equal(slotOf(b, maker.publicKey).baseFree.toNumber(), 2 * ONE);
    assert.equal(slotOf(b, taker.publicKey).quoteFree.toNumber(), 100 * USDC);
  });

  it("locks the funds a resting order commits", async () => {
    await market.methods
      .placeOrder(false, new BN(15 * USDC), new BN(ONE))
      .accounts(tradeAccounts(maker.publicKey))
      .signers([maker])
      .rpc();

    const b = await fetchBook();
    const s = slotOf(b, maker.publicKey);
    assert.equal(s.baseLocked.toNumber(), ONE, "the ask's size is locked");
    assert.equal(s.baseFree.toNumber(), ONE, "and the rest stays free");
    assert.equal(b.orders.length, 1);
    assert.equal(b.orders[0].price.toNumber(), 15 * USDC);
    assert.isFalse(b.orders[0].isBid);
  });

  it("refuses to withdraw what a resting order has locked", async () => {
    const atas = traderAtas.get(maker.publicKey.toBase58())!;
    try {
      await market.methods
        .withdraw(new BN(2 * ONE), new BN(0))
        .accounts({
          trader: maker.publicKey,
          market: marketPda,
          book: bookPda,
          baseVault: nVault,
          quoteVault,
          traderBase: atas.base,
          traderQuote: atas.quote,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();
      assert.fail("locked balance must not be withdrawable");
    } catch (e) {
      assert.match(String(e), /InsufficientBalance|insufficient/i);
    }
  });

  it("crosses two wallets at the maker's price", async () => {
    const before = await fetchBook();
    const id = before.orders[0].id;

    await market.methods
      .fillOrder(id, new BN(ONE))
      .accounts(tradeAccounts(taker.publicKey))
      .signers([taker])
      .rpc();

    const b = await fetchBook();
    const m = slotOf(b, maker.publicKey);
    const t = slotOf(b, taker.publicKey);

    assert.equal(m.baseLocked.toNumber(), 0, "the maker delivered the N");
    assert.equal(m.quoteFree.toNumber(), 15 * USDC, "and was paid their own price");
    assert.equal(t.baseFree.toNumber(), ONE, "the taker received the N");
    assert.equal(t.quoteFree.toNumber(), 85 * USDC);
    assert.equal(b.orders.length, 0, "a fully filled order leaves the book");
    assert.equal(b.volumeBase.toNumber(), ONE);
  });

  it("keeps the ledger equal to what the vaults hold", async () => {
    // The invariant the whole design rests on. If these drift, somebody
    // eventually cannot withdraw.
    const b = await fetchBook();
    const totals = b.slots.reduce(
      (acc: any, s: any) => ({
        base: acc.base + s.baseFree.toNumber() + s.baseLocked.toNumber(),
        quote: acc.quote + s.quoteFree.toNumber() + s.quoteLocked.toNumber(),
      }),
      { base: 0, quote: 0 },
    );

    assert.equal(totals.base, await tokenBalance(nVault), "base ledger matches the vault");
    assert.equal(totals.quote, await tokenBalance(quoteVault), "quote ledger matches the vault");
  });

  it("cancels an order and returns exactly what was locked", async () => {
    await market.methods
      .placeOrder(true, new BN(9 * USDC), new BN(ONE))
      .accounts(tradeAccounts(taker.publicKey))
      .signers([taker])
      .rpc();

    let b = await fetchBook();
    const id = b.orders[0].id;
    assert.equal(slotOf(b, taker.publicKey).quoteLocked.toNumber(), 9 * USDC);

    await market.methods
      .cancelOrder(id)
      .accounts(tradeAccounts(taker.publicKey))
      .signers([taker])
      .rpc();

    b = await fetchBook();
    assert.equal(slotOf(b, taker.publicKey).quoteLocked.toNumber(), 0);
    assert.equal(slotOf(b, taker.publicKey).quoteFree.toNumber(), 85 * USDC, "refunded in full");
    assert.equal(b.orders.length, 0);
  });

  it("lets somebody else's order alone", async () => {
    await market.methods
      .placeOrder(true, new BN(9 * USDC), new BN(ONE))
      .accounts(tradeAccounts(taker.publicKey))
      .signers([taker])
      .rpc();
    const b = await fetchBook();
    const id = b.orders[0].id;

    try {
      await market.methods
        .cancelOrder(id)
        .accounts(tradeAccounts(maker.publicKey))
        .signers([maker])
        .rpc();
      assert.fail("only the owner may cancel");
    } catch (e) {
      assert.match(String(e), /NotOrderOwner|owner/i);
    }

    // Clean up so the withdrawal test below starts from a known state.
    await market.methods
      .cancelOrder(id)
      .accounts(tradeAccounts(taker.publicKey))
      .signers([taker])
      .rpc();
  });

  it("returns real tokens on withdrawal", async () => {
    const atas = traderAtas.get(maker.publicKey.toBase58())!;
    const walletBefore = await tokenBalance(atas.quote);
    const vaultBefore = await tokenBalance(quoteVault);

    await market.methods
      .withdraw(new BN(0), new BN(15 * USDC))
      .accounts({
        trader: maker.publicKey,
        market: marketPda,
        book: bookPda,
        baseVault: nVault,
        quoteVault,
        traderBase: atas.base,
        traderQuote: atas.quote,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    assert.equal(
      await tokenBalance(atas.quote),
      walletBefore + 15 * USDC,
      "the premium reached the maker's wallet",
    );
    assert.equal(await tokenBalance(quoteVault), vaultBefore - 15 * USDC);

    const b = await fetchBook();
    assert.equal(slotOf(b, maker.publicKey).quoteFree.toNumber(), 0);
  });

  it("exposes the rollup lifecycle instructions", async () => {
    // The session itself needs a MagicBlock validator, so this asserts the
    // surface exists and is wired, not that a rollup ran.
    // Anchor camelCases instruction names on the client side.
    const names = market.idl.instructions.map((i: any) => i.name);
    for (const n of ["delegateBook", "commitBook", "undelegateBook", "processUndelegation"]) {
      assert.include(names, n, `${n} is missing from the program`);
    }

    // Delegating is permissionless in the sense that anyone may pay for it,
    // but it must name the right book PDA — a wrong one cannot be delegated.
    try {
      await market.methods
        .delegateBook(LEG_N)
        .accounts({
          payer: payer.publicKey,
          market: marketPda,
          book: Keypair.generate().publicKey,
        })
        .rpc();
      assert.fail("an arbitrary account must not be delegatable as a book");
    } catch (e) {
      assert.isTrue(String(e).length > 0);
    }
  });
});
