// SPDX-License-Identifier: Apache-2.0
//
// Compatibility proof for the two upstream building blocks proposed for the
// Erodoro order book:
//
//   1. ephemeral-spl-token delegates native SPL balances to MagicBlock.
//   2. The delegated balances are projected at normal ATA addresses, so an
//      unmodified SPL Token instruction can move them inside the rollup.
//   3. The funds can be withdrawn to Solana again.
//   4. Manifest uses those same normal ATA addresses for trader deposits.
//
// The final assertion is intentionally structural. Manifest's stock program
// has no instruction that delegates its writable market account, so a complete
// Manifest order cannot be executed on the rollup without adapting/forking the
// program. This suite proves the token side and keeps that program-state
// boundary explicit instead of claiming an end-to-end integration that does
// not yet exist.
//
//   pnpm devnet:manifest-ephemeral

import * as chai from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  createDelegateInstruction,
  delegateSpl,
  deriveEphemeralAta,
  transferSpl,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ManifestClient,
  Market,
  OrderType,
  createBatchUpdateInstruction,
} from "@bonasa-tech/manifest-sdk";

const assert: Chai.AssertStatic = chai.assert;

const BASE_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const ER_URL = process.env.EPHEMERAL_PROVIDER_ENDPOINT ?? "https://devnet.magicblock.app";
const VALIDATOR = new PublicKey(
  process.env.VALIDATOR ?? "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
);
const MANIFEST_PROGRAM_ID = new PublicKey("MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms");
const DECIMALS = 6;
const UNIT = 10 ** DECIMALS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadPayer(): Keypair {
  const walletPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
}

async function waitForTokenAmount(
  connection: Connection,
  address: PublicKey,
  expected: bigint,
  label: string,
  attempts = 240,
): Promise<bigint> {
  let lastError = "account not available";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const amount = (await getAccount(connection, address, "confirmed", TOKEN_PROGRAM_ID)).amount;
      if (amount === expected) return amount;
      lastError = `balance is ${amount}, expected ${expected}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function sendWithdrawalUntilSettled(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  destination: PublicKey,
  expected: bigint,
  label: string,
): Promise<void> {
  let lastError = "withdrawal did not settle";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(...instructions), signers, {
        commitment: "confirmed",
      });
    } catch (error) {
      // Idempotent shuttle instructions may report that setup already exists
      // on a retry. Settlement is the authoritative success condition.
      lastError = error instanceof Error ? error.message : String(error);
    }
    try {
      await waitForTokenAmount(connection, destination, expected, label, 80);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${label} failed after idempotent retries: ${lastError}`);
}

async function waitForStableTokenAmount(
  connection: Connection,
  address: PublicKey,
  minimum: bigint,
  label: string,
): Promise<bigint> {
  let previous: bigint | null = null;
  let unchangedReads = 0;
  let lastError = "account not available";
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const amount = (await getAccount(connection, address, "confirmed", TOKEN_PROGRAM_ID)).amount;
      if (amount >= minimum && amount === previous) {
        unchangedReads += 1;
        if (unchangedReads >= 5) return amount;
      } else {
        unchangedReads = 0;
      }
      previous = amount;
      lastError = `last balance was ${amount}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`${label} did not stabilize: ${lastError}`);
}

async function sendToRollup(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
): Promise<string> {
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = feePayer.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  transaction.sign(feePayer, ...signers);

  const signature = await connection.sendRawTransaction(transaction.serialize());
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) {
      throw new Error(`rollup rejected ${signature}: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await sleep(250);
  }
  throw new Error(`rollup transaction ${signature} never confirmed`);
}

describe("Manifest + ephemeral SPL compatibility on devnet", () => {
  const payer = loadPayer();
  const recipient = Keypair.generate();
  const rollupFeePayer = Keypair.generate();
  const base = new Connection(BASE_URL, "confirmed");
  const rollup = new Connection(ER_URL, "confirmed");

  let mint: PublicKey;
  let quoteMint: PublicKey;
  let payerAta: PublicKey;
  let recipientAta: PublicKey;
  let manifestMarket: PublicKey;
  let manifestMarketKeypair: Keypair;
  let manifestClient: ManifestClient;

  before("create and fund disposable native SPL accounts", async function () {
    assert.include(BASE_URL, "devnet", "this destructive fixture is devnet-only");
    assert.include(ER_URL, "devnet", "this destructive fixture is devnet-only");

    const identityResponse = await (rollup as any)._rpcRequest("getIdentity", []);
    assert.equal(identityResponse.result.identity, VALIDATOR.toBase58());
    for (const [name, programId, connection] of [
      ["ephemeral SPL", EPHEMERAL_SPL_TOKEN_PROGRAM_ID, base],
      ["Manifest on Solana", MANIFEST_PROGRAM_ID, base],
      ["Manifest on MagicBlock", MANIFEST_PROGRAM_ID, rollup],
    ] as const) {
      const info = await connection.getAccountInfo(programId, "confirmed");
      assert.isNotNull(info, `${name} program is missing`);
      assert.isTrue(info!.executable, `${name} program is not executable`);
    }

    mint = await createMint(base, payer, payer.publicKey, null, DECIMALS);
    quoteMint = await createMint(base, payer, payer.publicKey, null, DECIMALS);
    payerAta = await createAssociatedTokenAccount(base, payer, mint, payer.publicKey);
    recipientAta = await createAssociatedTokenAccount(base, payer, mint, recipient.publicKey);
    await mintTo(base, payer, mint, payerAta, payer, 5 * UNIT);
    await mintTo(base, payer, mint, recipientAta, payer, UNIT);
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: rollupFeePayer.publicKey,
        lamports: 10_000_000,
      })),
      [payer],
      { commitment: "confirmed" },
    );

    const setup = await Market.setupIxs(base, mint, quoteMint, payer.publicKey);
    await sendAndConfirmTransaction(base, new Transaction().add(...setup.ixs), [payer, ...setup.signers], {
      commitment: "confirmed",
    });
    manifestMarketKeypair = setup.signers[0] as Keypair;
    manifestMarket = manifestMarketKeypair.publicKey;
    manifestClient = await ManifestClient.getClientForMarket(base, manifestMarket, payer);
  });

  it("delegates native SPL balances, transfers through Tokenkeg on MagicBlock, and withdraws", async () => {
    const payerDelegate = await delegateSpl(payer.publicKey, mint, BigInt(3 * UNIT), {
      payer: payer.publicKey,
      validator: VALIDATOR,
      tokenProgram: TOKEN_PROGRAM_ID,
      initIfMissing: true,
      initVaultIfMissing: true,
      initAtasIfMissing: true,
      idempotent: true,
    });
    await sendAndConfirmTransaction(base, new Transaction().add(...payerDelegate), [payer], {
      commitment: "confirmed",
    });

    const recipientDelegate = await delegateSpl(recipient.publicKey, mint, BigInt(UNIT), {
      payer: payer.publicKey,
      validator: VALIDATOR,
      tokenProgram: TOKEN_PROGRAM_ID,
      initIfMissing: true,
      initVaultIfMissing: false,
      initAtasIfMissing: true,
      idempotent: true,
    });
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(...recipientDelegate),
      [payer, recipient],
      { commitment: "confirmed" },
    );

    const [payerEphemeralAta] = deriveEphemeralAta(payer.publicKey, mint);
    const delegatedInfo = await base.getAccountInfo(payerEphemeralAta, "confirmed");
    assert.isNotNull(delegatedInfo, "eATA was not created on Solana");
    assert.equal(delegatedInfo!.owner.toBase58(), DELEGATION_PROGRAM_ID.toBase58());

    const payerBefore = await waitForStableTokenAmount(
      rollup,
      getAssociatedTokenAddressSync(mint, payer.publicKey),
      BigInt(3 * UNIT),
      "payer projected ATA",
    );
    const recipientBefore = await waitForStableTokenAmount(
      rollup,
      getAssociatedTokenAddressSync(mint, recipient.publicKey),
      BigInt(UNIT),
      "recipient projected ATA",
    );

    const transferAmount = BigInt(UNIT / 2);
    const transferInstructions = await transferSpl(
      payer.publicKey,
      recipient.publicKey,
      mint,
      transferAmount,
      {
        payer: payer.publicKey,
        validator: VALIDATOR,
        tokenProgram: TOKEN_PROGRAM_ID,
        visibility: "public",
        fromBalance: "ephemeral",
        toBalance: "ephemeral",
      },
    );
    assert.lengthOf(transferInstructions, 1);
    assert.equal(transferInstructions[0].programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(transferInstructions[0].keys[0].pubkey.toBase58(), payerAta.toBase58());
    assert.equal(transferInstructions[0].keys[1].pubkey.toBase58(), recipientAta.toBase58());
    await sendToRollup(rollup, transferInstructions, payer);

    const payerAfter = await waitForTokenAmount(
      rollup,
      payerAta,
      payerBefore - transferAmount,
      "payer transferred balance",
    );
    const recipientAfter = await waitForTokenAmount(
      rollup,
      recipientAta,
      recipientBefore + transferAmount,
      "recipient transferred balance",
    );
    assert.equal(payerAfter, payerBefore - transferAmount);
    assert.equal(recipientAfter, recipientBefore + transferAmount);

    const payerWithdraw = await withdrawSpl(payer.publicKey, mint, payerAfter, {
      payer: payer.publicKey,
      validator: VALIDATOR,
      tokenProgram: TOKEN_PROGRAM_ID,
      initIfMissing: true,
      initAtasIfMissing: true,
      idempotent: true,
    });
    await sendWithdrawalUntilSettled(
      base,
      payerWithdraw,
      [payer],
      payerAta,
      BigInt(5 * UNIT) - transferAmount,
      "payer Solana withdrawal",
    );

    const recipientWithdraw = await withdrawSpl(recipient.publicKey, mint, recipientAfter, {
      payer: payer.publicKey,
      validator: VALIDATOR,
      tokenProgram: TOKEN_PROGRAM_ID,
      initIfMissing: true,
      initAtasIfMissing: true,
      idempotent: true,
    });
    await sendWithdrawalUntilSettled(
      base,
      recipientWithdraw,
      [payer, recipient],
      recipientAta,
      BigInt(UNIT) + transferAmount,
      "recipient Solana withdrawal",
    );
  });

  it("proves stock Manifest core state needs an owner-program delegation adapter", async () => {
    const deposit = manifestClient.depositIx(payer.publicKey, mint, 1);
    assert.isTrue(
      deposit.keys.some((key) => key.pubkey.equals(payerAta) && key.isWritable),
      "Manifest must consume the canonical trader ATA projected by ephemeral-spl-token",
    );
    await sendAndConfirmTransaction(base, new Transaction().add(deposit), [payer], {
      commitment: "confirmed",
    });

    const placeOnSolana = manifestClient.batchUpdateIx(
      [{
        numBaseTokens: 0.25,
        tokenPrice: 1,
        isBid: false,
        lastValidSlot: 0,
        orderType: OrderType.Limit,
        clientOrderId: 1,
      }],
      [],
      false,
    );
    await sendAndConfirmTransaction(base, new Transaction().add(placeOnSolana), [payer], {
      commitment: "confirmed",
    });

    const loaded = await Market.loadFromAddress({ connection: base, address: manifestMarket });
    assert.equal(loaded.asks().length, 1, "stock Manifest did not place an L1 order");
    assert.equal(loaded.getWithdrawableBalanceTokens(payer.publicKey, true), 0.75);

    // Use the core instruction directly so the only non-system writable state
    // is the Manifest market. This isolates the failure from wrapper state.
    const placeOnRollup = createBatchUpdateInstruction(
      { payer: payer.publicKey, market: manifestMarket },
      { params: { traderIndexHint: null, cancels: [], orders: [] } },
    );

    let rejection = "";
    try {
      await sendToRollup(rollup, [placeOnRollup], rollupFeePayer, [payer]);
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    console.log(`      expected stock Manifest rejection: ${rejection}`);
    assert.isNotEmpty(
      rejection,
      "stock Manifest unexpectedly wrote non-delegated market/wrapper state on MagicBlock",
    );
    assert.include(rejection, "writable account that cannot be written");

    // Manifest creates each market from a normal keypair, but retaining that
    // keypair is not sufficient: delegation also requires the account's owner
    // program to hand ownership to MagicBlock. Stock Manifest has no such
    // instruction, so a fork/adapter inside the owning program is required.
    const delegateMarket = createDelegateInstruction(
      {
        payer: payer.publicKey,
        delegatedAccount: manifestMarket,
        ownerProgram: MANIFEST_PROGRAM_ID,
        validator: VALIDATOR,
      },
      { validator: VALIDATOR },
    );
    let delegationRejection = "";
    try {
      await sendAndConfirmTransaction(
        base,
        new Transaction().add(delegateMarket),
        [payer, manifestMarketKeypair],
        { commitment: "confirmed" },
      );
    } catch (error) {
      delegationRejection = error instanceof Error ? error.message : String(error);
    }
    assert.include(delegationRejection, "Invalid account owner");

    const marketInfo = await base.getAccountInfo(manifestMarket, "confirmed");
    assert.equal(marketInfo!.owner.toBase58(), MANIFEST_PROGRAM_ID.toBase58());
    assert.notEqual(marketInfo!.owner.toBase58(), DELEGATION_PROGRAM_ID.toBase58());
  });
});
