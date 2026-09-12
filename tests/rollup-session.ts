// SPDX-License-Identifier: Apache-2.0
//
// A real ephemeral-rollup session, end to end.
//
// Everything else in this repo tests the L1 half of the market and takes the
// rollup on trust. This opens an actual session against a MagicBlock
// validator: it delegates the book, trades inside the rollup, commits the
// ledger back, undelegates, and withdraws real tokens on the base layer.
//
// What it is really checking is the boundary, in both directions:
//
//   - Trading works in the rollup with no token accounts in the instruction,
//     which is the property that makes the hot path delegable at all.
//   - While delegated, `deposit` and `withdraw` on L1 **fail** — the book is
//     owned by the delegation program, so Anchor's owner check rejects them.
//     That is not a nuisance, it is the thing that stops the rollup's ledger
//     and the vault's contents from ever disagreeing.
//   - After undelegation the committed balances are on L1 and withdrawable.
//
// Requires the local stack:
//
//   mb-stack --reset --upgradeable-program \
//     target/deploy/market-keypair.json target/deploy/market.so $(solana address)
//
//   pnpm rollup

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";
const BN = (anchor as any).BN ?? (anchor as any).default.BN;
const { assert } = chai;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.PROVIDER_ENDPOINT ?? "http://localhost:8899";
const ER_URL = process.env.EPHEMERAL_PROVIDER_ENDPOINT ?? "http://localhost:7799";
/** The local ER validator's identity, which the delegation names. */
const VALIDATOR = new PublicKey(
  process.env.VALIDATOR ?? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev",
);

const enc = new TextEncoder();
const seed = (s: string) => Buffer.from(enc.encode(s));
const ONE = 100_000_000; // one whole P/N, 8 decimals
const USDC = 1_000_000; // one dollar, 6 decimals
const LEG_N = { n: {} };
const LEG_N_TAG = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("an ephemeral rollup session", () => {
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      Buffer.from(
        JSON.parse(
          fs.readFileSync(
            process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`,
            "utf8",
          ),
        ),
      ),
    ),
  );
  const payer = wallet.payer;

  const base = new Connection(BASE_URL, "confirmed");
  const er = new Connection(ER_URL, "confirmed");

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "target/idl/market.json"), "utf8"),
  );

  // Two clients over the same program: one pointed at the base layer, one at
  // the rollup. Identical instructions; only the endpoint differs.
  const onBase = new anchor.Program(
    idl,
    new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }),
  );
  const onEr = new anchor.Program(
    idl,
    new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }),
  );

  const maker = Keypair.generate();
  const taker = Keypair.generate();

  let nMint: PublicKey;
  let quoteMint: PublicKey;
  let marketPda: PublicKey;
  let bookPda: PublicKey;
  let nVault: PublicKey;
  let quoteVault: PublicKey;
  const atas = new Map<string, { base: PublicKey; quote: PublicKey }>();

  const slotOf = (book: any, who: PublicKey) =>
    book.slots.find((s: any) => s.occupied && s.owner.equals(who));

  const fetchBookFrom = (c: Connection) =>
    new anchor.Program(idl, new anchor.AnchorProvider(c, wallet, { commitment: "confirmed" }))
      .account.book.fetch(bookPda);

  /**
   * Decode the book straight out of L1's account bytes, ignoring the owner.
   *
   * `account.book.fetch` refuses a delegated account — its owner is the
   * delegation program, which is the whole point — but the bytes are still
   * there and are exactly what L1 believes. Reading them directly is the only
   * way to tell "L1 has not been told yet" apart from "L1 cannot be read",
   * and those two are the difference between a real assertion and a vacuous
   * one.
   */
  const decodeBookOnL1 = async () => {
    const info = await base.getAccountInfo(bookPda);
    assert.isNotNull(info, "the book has no account on L1 at all");
    return onBase.coder.accounts.decode("book", info!.data) as any;
  };

  /**
   * Send to the rollup and wait by polling the signature.
   *
   * Worth knowing if you write a client against this. `sendAndConfirm` waits
   * on a signature notification, and against the rollup that notification is
   * unreliable: `commit_book` lands and reports `finalized` a moment later via
   * `getSignatureStatuses`, but the wait throws `TransactionExpiredTimeoutError`
   * on a transaction that already succeeded. Mixing the two paths is worse
   * still — the first `.rpc()` after a raw send reliably stalls for the full
   * 30-second timeout before resolving.
   *
   * So every rollup call here goes through one path, and it polls. That also
   * makes the latency numbers printed below mean something: they measure the
   * rollup, not web3.js's confirmation machinery.
   */
  async function sendToEr(ix: TransactionInstruction, signers: Keypair[] = []) {
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(payer, ...signers);

    const sig = await er.sendRawTransaction(tx.serialize());
    for (let i = 0; i < 120; i++) {
      const status = (await er.getSignatureStatuses([sig])).value[0];
      if (status?.err) throw new Error(`rollup rejected ${sig}: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return sig;
      }
      await sleep(250);
    }
    throw new Error(`rollup transaction ${sig} never confirmed`);
  }

  function bookAccounts(who: PublicKey) {
    const a = atas.get(who.toBase58())!;
    return {
      trader: who,
      market: marketPda,
      book: bookPda,
      baseVault: nVault,
      quoteVault,
      traderBase: a.base,
      traderQuote: a.quote,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  before("stand up a market and fund two traders on the base layer", async function () {
    for (const [name, c] of [["base", base], ["ephemeral", er]] as const) {
      try {
        await c.getVersion();
      } catch {
        console.log(`        ${name} validator not reachable — start the MagicBlock stack first`);
        this.skip();
      }
    }

    await base.confirmTransaction(
      await base.requestAirdrop(payer.publicKey, 50 * 1e9),
      "confirmed",
    );

    nMint = await createMint(base, payer, payer.publicKey, null, 8);
    quoteMint = await createMint(base, payer, payer.publicKey, null, 6);
    const pMint = await createMint(base, payer, payer.publicKey, null, 8);
    const series = Keypair.generate().publicKey;

    marketPda = PublicKey.findProgramAddressSync(
      [seed("market"), series.toBuffer()],
      onBase.programId,
    )[0];
    bookPda = PublicKey.findProgramAddressSync(
      [seed("book"), marketPda.toBuffer(), Buffer.from([LEG_N_TAG])],
      onBase.programId,
    )[0];
    nVault = getAssociatedTokenAddressSync(nMint, marketPda, true);
    quoteVault = getAssociatedTokenAddressSync(quoteMint, marketPda, true);

    await onBase.methods
      .initializeMarket(new BN(Math.floor(Date.now() / 1000) + 30 * 86400))
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
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await onBase.methods
      .initializeBook(LEG_N)
      .accounts({
        payer: payer.publicKey,
        market: marketPda,
        book: bookPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // The maker sells N and holds it; the taker buys and holds USDC.
    for (const [kp, n, q] of [
      [maker, 5 * ONE, 0],
      [taker, 0, 500 * USDC],
    ] as const) {
      const b = await createAssociatedTokenAccountIdempotent(base, payer, nMint, kp.publicKey);
      const qa = await createAssociatedTokenAccountIdempotent(base, payer, quoteMint, kp.publicKey);
      atas.set(kp.publicKey.toBase58(), { base: b, quote: qa });
      if (n > 0) await mintTo(base, payer, nMint, b, payer, n);
      if (q > 0) await mintTo(base, payer, quoteMint, qa, payer, q);
    }

    // Deposit on L1, before any delegation — this is the only way value enters.
    for (const [kp, n, q] of [
      [maker, 2 * ONE, 0],
      [taker, 0, 100 * USDC],
    ] as const) {
      await onBase.methods
        .deposit(new BN(n), new BN(q))
        .accounts(bookAccounts(kp.publicKey))
        .signers([kp])
        .rpc();
    }
  });

  it("delegates the book to the rollup validator", async () => {
    await onBase.methods
      .delegateBook(LEG_N)
      .accounts({ payer: payer.publicKey, market: marketPda, book: bookPda })
      // The validator to delegate to, read from `remaining_accounts`.
      .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .rpc();

    const info = await base.getAccountInfo(bookPda);
    assert.isNotNull(info);
    assert.notEqual(
      info!.owner.toBase58(),
      onBase.programId.toBase58(),
      "a delegated book is owned by the delegation program, not by `market`",
    );

    // And the rollup can now see it. It may take a moment to clone.
    let cloned = null;
    for (let i = 0; i < 30 && !cloned; i++) {
      cloned = await er.getAccountInfo(bookPda);
      if (!cloned) await sleep(500);
    }
    assert.isNotNull(cloned, "the rollup never cloned the delegated book");
  });

  it("refuses deposits and withdrawals on L1 while the session is open", async () => {
    // The property the whole escrow design leans on, and it costs no code:
    // Anchor's owner check rejects these because the delegation program owns
    // the account. A balance cannot be withdrawn while the rollup is still
    // mutating it, so the ledger and the vaults cannot diverge.
    for (const [label, build] of [
      ["deposit", () => onBase.methods.deposit(new BN(ONE), new BN(0))],
      ["withdraw", () => onBase.methods.withdraw(new BN(ONE), new BN(0))],
    ] as const) {
      let rejected = false;
      try {
        await build().accounts(bookAccounts(maker.publicKey)).signers([maker]).rpc();
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected, `${label} must fail on L1 while the book is delegated`);
    }
  });

  it("trades inside the rollup", async () => {
    // The same instructions as on L1. They carry no token accounts, which is
    // exactly why they can run here.
    const t0 = Date.now();
    await sendToEr(
      await onEr.methods
        .placeOrder(false, new BN(15 * USDC), new BN(ONE))
        .accounts({ trader: maker.publicKey, market: marketPda, book: bookPda })
        .instruction(),
      [maker],
    );
    const placeMs = Date.now() - t0;

    let book: any = await fetchBookFrom(er);
    assert.equal(book.orders.length, 1, "the ask is resting in the rollup");
    assert.equal(slotOf(book, maker.publicKey).baseLocked.toNumber(), ONE);

    const t1 = Date.now();
    await sendToEr(
      await onEr.methods
        .fillOrder(book.orders[0].id, new BN(ONE))
        .accounts({ trader: taker.publicKey, market: marketPda, book: bookPda })
        .instruction(),
      [taker],
    );
    const fillMs = Date.now() - t1;

    book = await fetchBookFrom(er);
    const m = slotOf(book, maker.publicKey);
    const t = slotOf(book, taker.publicKey);
    assert.equal(m.quoteFree.toNumber(), 15 * USDC, "the maker was paid their own price");
    assert.equal(t.baseFree.toNumber(), ONE, "the taker received the N");
    assert.equal(book.orders.length, 0);
    assert.equal(book.volumeBase.toNumber(), ONE);

    console.log(`        place ${placeMs}ms · fill ${fillMs}ms, in the rollup`);
  });

  it("leaves the base layer untouched until someone commits", async () => {
    // This is what makes a session cheap: the fill above cost the base layer
    // nothing, and L1 still holds the pre-session ledger.
    const onL1 = await decodeBookOnL1();
    assert.equal(onL1.volumeBase.toNumber(), 0, "L1 has not been told about the fill");
    assert.isNotOk(
      slotOf(onL1, taker.publicKey)?.baseFree.toNumber(),
      "and the taker's N exists only in the rollup so far",
    );
  });

  it("commits mid-session without ending it", async () => {
    // `commit_book` is the checkpoint: it pushes the ledger to L1 but leaves
    // the book delegated, so a long-running session can bound how much state
    // a validator failure would cost without paying to reopen.
    const t0 = Date.now();
    await sendToEr(
      await onEr.methods
        .commitBook()
        .accounts({ payer: payer.publicKey, book: bookPda })
        .instruction(),
    );
    const acceptedMs = Date.now() - t0;

    let onL1: any;
    for (let i = 0; i < 240; i++) {
      onL1 = await decodeBookOnL1();
      if (onL1.volumeBase.toNumber() > 0) break;
      await sleep(250);
    }
    // Two very different numbers, and the gap is the point: the rollup accepts
    // a commit immediately, but the write only appears on L1 once the
    // validator's commit pipeline gets round to it. Anything reading L1 has to
    // treat a committed balance as eventually-consistent.
    console.log(
      `        commit accepted in ${acceptedMs}ms · visible on L1 after ${Date.now() - t0}ms`,
    );
    assert.equal(onL1.volumeBase.toNumber(), ONE, "the commit reached the base layer");
    assert.equal(
      slotOf(onL1, maker.publicKey).quoteFree.toNumber(),
      15 * USDC,
      "including the maker's premium",
    );

    // Still delegated — L1 must keep refusing writes, and the rollup must
    // keep accepting them.
    const info = await base.getAccountInfo(bookPda);
    assert.notEqual(
      info!.owner.toBase58(),
      onBase.programId.toBase58(),
      "a commit is not an undelegation",
    );

    const t2 = Date.now();
    await sendToEr(
      await onEr.methods
        .placeOrder(true, new BN(9 * USDC), new BN(ONE))
        .accounts({ trader: taker.publicKey, market: marketPda, book: bookPda })
        .instruction(),
      [taker],
    );
    console.log(`        post-commit order in ${Date.now() - t2}ms`);
    const inEr: any = await fetchBookFrom(er);
    assert.equal(inEr.orders.length, 1, "the session is still live and taking orders");
  });

  it("commits and undelegates, landing the balances back on L1", async () => {
    // Cancel first: an undelegation with locked balance is legitimate, but
    // leaving it locked would muddy the withdrawal assertion below.
    const resting: any = await fetchBookFrom(er);
    await sendToEr(
      await onEr.methods
        .cancelOrder(resting.orders[0].id)
        .accounts({ trader: taker.publicKey, market: marketPda, book: bookPda })
        .instruction(),
      [taker],
    );

    await sendToEr(
      await onEr.methods
        .undelegateBook()
        .accounts({ payer: payer.publicKey, book: bookPda })
        .instruction(),
    );

    // Undelegation lands asynchronously: the rollup commits, then the
    // delegation program hands ownership back.
    let owned = false;
    for (let i = 0; i < 60 && !owned; i++) {
      const info = await base.getAccountInfo(bookPda);
      owned = Boolean(info && info.owner.equals(onBase.programId));
      if (!owned) await sleep(500);
    }
    assert.isTrue(owned, "the book never came back to the market program");

    const book: any = await fetchBookFrom(base);
    assert.equal(book.volumeBase.toNumber(), ONE, "the fill is now on the base layer");
    assert.equal(
      slotOf(book, maker.publicKey).quoteFree.toNumber(),
      15 * USDC,
      "and so is the maker's premium",
    );
  });

  it("pays the premium out in real tokens", async () => {
    const a = atas.get(maker.publicKey.toBase58())!;
    const before = Number((await getAccount(base, a.quote)).amount);

    await onBase.methods
      .withdraw(new BN(0), new BN(15 * USDC))
      .accounts(bookAccounts(maker.publicKey))
      .signers([maker])
      .rpc();

    assert.equal(
      Number((await getAccount(base, a.quote)).amount),
      before + 15 * USDC,
      "the premium earned in the rollup reached a real wallet on L1",
    );

    // And the ledger still matches the vaults after a full round trip.
    const book: any = await fetchBookFrom(base);
    const totals = book.slots.reduce(
      (acc: any, s: any) => ({
        base: acc.base + s.baseFree.toNumber() + s.baseLocked.toNumber(),
        quote: acc.quote + s.quoteFree.toNumber() + s.quoteLocked.toNumber(),
      }),
      { base: 0, quote: 0 },
    );
    assert.equal(totals.base, Number((await getAccount(base, nVault)).amount));
    assert.equal(totals.quote, Number((await getAccount(base, quoteVault)).amount));
  });
});
