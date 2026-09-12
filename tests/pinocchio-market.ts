// SPDX-License-Identifier: Apache-2.0
//
// The Pinocchio build of the market, executed on a validator.
//
// `variants/market-pinocchio` has 22 host tests and not one of them runs the
// program: 16 compare the two matching engines, 6 compare the MagicBlock
// payloads against the SDK. This is the tier that executes it -- PDA
// derivation, three ATA creations, SPL transfers in and out, the market PDA
// signing a withdrawal, and the Anchor event wire format.
//
//   make pinocchio-market
//
// The four delegation instructions are not exercised here. `delegate_book`,
// `commit_book`, `undelegate_book` and `process_undelegation` need the
// delegation and magic programs, which a plain `solana-test-validator` does not
// have; that is what `make rollup` and a MagicBlock stack are for. Their
// payloads are proven byte-identical to the SDK's in
// `variants/market-pinocchio/tests/delegation_wire.rs`, which is a real check
// but is not the same as having run them. Recorded in variants/COMPARISON.md.

import * as anchor from "@coral-xyz/anchor";
import * as chai from "chai";
const { assert } = chai;
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";

const MARKET_ID = new PublicKey("FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC");

const MARKET_SEED = Buffer.from("market");
const BOOK_SEED = Buffer.from("book");

/** 8 decimals for P and N, so one whole unit is 1e8 raw. */
const BASE_UNIT = 100_000_000n;

const ixDisc = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const eventDisc = (name: string) =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

const IX = {
  initializeMarket: ixDisc("initialize_market"),
  initializeBook: ixDisc("initialize_book"),
  deposit: ixDisc("deposit"),
  withdraw: ixDisc("withdraw"),
  placeOrder: ixDisc("place_order"),
  cancelOrder: ixDisc("cancel_order"),
  fillOrder: ixDisc("fill_order"),
};

const i64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/** `Book`, as this build writes it. Vectors are a u32 length then elements. */
function decodeBook(data: Buffer) {
  let o = 8;
  const market = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const leg = data[o];
  o += 1;
  const slotCount = data.readUInt32LE(o);
  o += 4;
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    slots.push({
      owner: new PublicKey(data.subarray(o, o + 32)),
      baseFree: data.readBigUInt64LE(o + 32),
      baseLocked: data.readBigUInt64LE(o + 40),
      quoteFree: data.readBigUInt64LE(o + 48),
      quoteLocked: data.readBigUInt64LE(o + 56),
      occupied: data[o + 64] !== 0,
    });
    o += 65;
  }
  const orderCount = data.readUInt32LE(o);
  o += 4;
  const orders = [];
  for (let i = 0; i < orderCount; i++) {
    orders.push({
      id: data.readBigUInt64LE(o),
      trader: data[o + 8],
      isBid: data[o + 9] !== 0,
      price: data.readBigUInt64LE(o + 10),
      remaining: data.readBigUInt64LE(o + 18),
      active: data[o + 26] !== 0,
    });
    o += 27;
  }
  return {
    market,
    leg,
    slots,
    orders,
    nextOrderId: data.readBigUInt64LE(o),
    volumeBase: data.readBigUInt64LE(o + 8),
    bump: data[o + 16],
  };
}

function findEvent(logs: string[], disc: Buffer): Buffer | undefined {
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/);
    if (!m) continue;
    const raw = Buffer.from(m[1], "base64");
    if (raw.length >= 8 && raw.subarray(0, 8).equals(disc)) return raw;
  }
  return undefined;
}

describe("market, Pinocchio build, on a validator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // A stand-in for the series this market quotes. The market records it as an
  // identifier and never has authority over it, so a fresh key is enough.
  const series = Keypair.generate().publicKey;

  let pMint: PublicKey, nMint: PublicKey, quoteMint: PublicKey;
  let marketPda: PublicKey, bookPda: PublicKey;
  let pVault: PublicKey, nVault: PublicKey, quoteVault: PublicKey;
  let traderBase: PublicKey, traderQuote: PublicKey;
  const maturity = BigInt(Math.floor(Date.now() / 1000) + 86_400);

  const send = (ix: TransactionInstruction, signers: Keypair[] = []) =>
    provider.sendAndConfirm(new Transaction().add(ix), signers);

  /** Logs from a simulation; `getTransaction` does not reliably carry them. */
  async function sendForLogs(ix: TransactionInstruction, signers: Keypair[] = []) {
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx, [payer, ...signers]);
    if (sim.value.err) {
      throw new Error(
        JSON.stringify(sim.value.err) + " :: " + (sim.value.logs ?? []).join("\n"),
      );
    }
    const logs = sim.value.logs ?? [];
    await send(ix, signers);
    return logs;
  }

  before(async function () {
    const info = await connection.getAccountInfo(MARKET_ID);
    if (!info?.executable) {
      console.log("        market not deployed — run 'make pinocchio-market'");
      this.skip();
    }

    // P and N are plain SPL mints at 8 decimals; the quote stands in for USDC
    // at 6, which is what the wire format assumes.
    pMint = await createMint(connection, payer, payer.publicKey, null, 8);
    nMint = await createMint(connection, payer, payer.publicKey, null, 8);
    quoteMint = await createMint(connection, payer, payer.publicKey, null, 6);

    [marketPda] = PublicKey.findProgramAddressSync(
      [MARKET_SEED, series.toBuffer()],
      MARKET_ID,
    );
    // Leg N — the one that needs a buyer.
    [bookPda] = PublicKey.findProgramAddressSync(
      [BOOK_SEED, marketPda.toBuffer(), Buffer.from([1])],
      MARKET_ID,
    );

    const ata = (m: PublicKey) =>
      getAssociatedTokenAddressSync(m, marketPda, true, TOKEN_PROGRAM_ID);
    pVault = ata(pMint);
    nVault = ata(nMint);
    quoteVault = ata(quoteMint);

    traderBase = (
      await getOrCreateAssociatedTokenAccount(connection, payer, nMint, payer.publicKey)
    ).address;
    traderQuote = (
      await getOrCreateAssociatedTokenAccount(connection, payer, quoteMint, payer.publicKey)
    ).address;
    await mintTo(connection, payer, nMint, traderBase, payer, 10_000_000_000);
    await mintTo(connection, payer, quoteMint, traderQuote, payer, 10_000_000_000);
  });

  it("initializes a market and creates its three vaults", async () => {
    await send(
      new TransactionInstruction({
        programId: MARKET_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: series, isSigner: false, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: true },
          { pubkey: pMint, isSigner: false, isWritable: false },
          { pubkey: nMint, isSigner: false, isWritable: false },
          { pubkey: quoteMint, isSigner: false, isWritable: false },
          { pubkey: pVault, isSigner: false, isWritable: true },
          { pubkey: nVault, isSigner: false, isWritable: true },
          { pubkey: quoteVault, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([IX.initializeMarket, i64(maturity)]),
      }),
    );

    const info = await connection.getAccountInfo(marketPda);
    assert.isOk(info, "market created");
    assert.equal(info!.data.length, 241, "8 + InitSpace");
    assert.isTrue(info!.owner.equals(MARKET_ID));

    // The vaults are real token accounts owned by the market PDA.
    for (const [v, m] of [
      [pVault, pMint],
      [nVault, nMint],
      [quoteVault, quoteMint],
    ] as const) {
      const acct = await getAccount(connection, v);
      assert.isTrue(acct.owner.equals(marketPda), "vault authority is the market PDA");
      assert.isTrue(acct.mint.equals(m), "vault is over the right mint");
    }
  });

  it("opens the N book at the PDA the Anchor build would derive", async () => {
    await send(
      new TransactionInstruction({
        programId: MARKET_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: marketPda, isSigner: false, isWritable: false },
          { pubkey: bookPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([IX.initializeBook, Buffer.from([1])]),
      }),
    );

    const info = await connection.getAccountInfo(bookPda);
    assert.isOk(info, "book created");
    assert.equal(info!.data.length, 5602, "8 + InitSpace");
    const book = decodeBook(info!.data);
    assert.isTrue(book.market.equals(marketPda));
    assert.equal(book.leg, 1, "leg N");
    assert.equal(book.slots.length, 0);
    assert.equal(book.orders.length, 0);
    assert.equal(book.nextOrderId, 1n, "ids start at 1, as initialize_book sets");
  });

  it("deposits base and quote, moving real tokens", async () => {
    const before = await getAccount(connection, traderBase);
    const logs = await sendForLogs(
      new TransactionInstruction({
        programId: MARKET_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: false },
          { pubkey: bookPda, isSigner: false, isWritable: true },
          { pubkey: nVault, isSigner: false, isWritable: true },
          { pubkey: quoteVault, isSigner: false, isWritable: true },
          { pubkey: traderBase, isSigner: false, isWritable: true },
          { pubkey: traderQuote, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          IX.deposit,
          u64(500_000_000n),
          u64(900_000_000n),
        ]),
      }),
    );

    assert.equal(
      (await getAccount(connection, nVault)).amount,
      500_000_000n,
      "base landed in the vault",
    );
    assert.equal(
      (await getAccount(connection, traderBase)).amount,
      before.amount - 500_000_000n,
      "and left the trader",
    );

    const book = decodeBook((await connection.getAccountInfo(bookPda))!.data);
    assert.equal(book.slots.length, 1);
    assert.equal(book.slots[0].baseFree, 500_000_000n);
    assert.equal(book.slots[0].quoteFree, 900_000_000n);
    assert.isOk(findEvent(logs, eventDisc("Deposited")), "Deposited emitted");
  });

  it("rests an order, locking the base it commits", async () => {
    const logs = await sendForLogs(
      new TransactionInstruction({
        programId: MARKET_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: false },
          { pubkey: bookPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([
          IX.placeOrder,
          Buffer.from([0]), // ask
          u64(15_000_000n),
          u64(400_000_000n),
        ]),
      }),
    );

    const book = decodeBook((await connection.getAccountInfo(bookPda))!.data);
    assert.equal(book.orders.length, 1);
    assert.equal(book.orders[0].id, 1n);
    assert.equal(book.orders[0].remaining, 400_000_000n);
    assert.equal(book.slots[0].baseLocked, 400_000_000n, "locked at placement");
    assert.equal(book.slots[0].baseFree, 100_000_000n);
    assert.isOk(findEvent(logs, eventDisc("OrderPlaced")), "OrderPlaced emitted");
  });

  it("refuses a self-fill", async () => {
    try {
      await send(
        new TransactionInstruction({
          programId: MARKET_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: marketPda, isSigner: false, isWritable: false },
            { pubkey: bookPda, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([IX.fillOrder, u64(1n), u64(100_000_000n)]),
        }),
      );
      assert.fail("an order must not fill itself");
    } catch (e: any) {
      // 6008 SelfFill
      assert.match(String(e), /6008|SelfFill|custom program error/i);
    }
  });

  it("cancels the order and unlocks the base", async () => {
    const logs = await sendForLogs(
      new TransactionInstruction({
        programId: MARKET_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: false },
          { pubkey: bookPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([IX.cancelOrder, u64(1n)]),
      }),
    );
    const book = decodeBook((await connection.getAccountInfo(bookPda))!.data);
    assert.equal(book.orders.length, 0);
    assert.equal(book.slots[0].baseLocked, 0n);
    assert.equal(book.slots[0].baseFree, 500_000_000n, "back where it started");
    assert.isOk(findEvent(logs, eventDisc("OrderCancelled")), "OrderCancelled emitted");
  });

  it("withdraws, signed by the market PDA", async () => {
    const before = await getAccount(connection, traderBase);
    const logs = await sendForLogs(
      new TransactionInstruction({
        programId: MARKET_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: false },
          { pubkey: bookPda, isSigner: false, isWritable: true },
          { pubkey: nVault, isSigner: false, isWritable: true },
          { pubkey: quoteVault, isSigner: false, isWritable: true },
          { pubkey: traderBase, isSigner: false, isWritable: true },
          { pubkey: traderQuote, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([IX.withdraw, u64(500_000_000n), u64(900_000_000n)]),
      }),
    );

    assert.equal(
      (await getAccount(connection, traderBase)).amount,
      before.amount + 500_000_000n,
      "the vault paid out under the PDA's signature",
    );
    assert.equal((await getAccount(connection, nVault)).amount, 0n);

    // A slot holding nothing is released, so the table does not fill up with
    // traders who have long since left.
    const book = decodeBook((await connection.getAccountInfo(bookPda))!.data);
    assert.isFalse(book.slots[0].occupied, "empty slot released");
    assert.isOk(findEvent(logs, eventDisc("Withdrawn")), "Withdrawn emitted");
  });

  it("refuses to withdraw more than is free", async () => {
    try {
      await send(
        new TransactionInstruction({
          programId: MARKET_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: marketPda, isSigner: false, isWritable: false },
            { pubkey: bookPda, isSigner: false, isWritable: true },
            { pubkey: nVault, isSigner: false, isWritable: true },
            { pubkey: quoteVault, isSigner: false, isWritable: true },
            { pubkey: traderBase, isSigner: false, isWritable: true },
            { pubkey: traderQuote, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([IX.withdraw, u64(1n), u64(0n)]),
        }),
      );
      assert.fail("a released slot has nothing to withdraw");
    } catch (e: any) {
      // 6004 UnknownTrader
      assert.match(String(e), /6004|UnknownTrader|custom program error/i);
    }
  });
});
