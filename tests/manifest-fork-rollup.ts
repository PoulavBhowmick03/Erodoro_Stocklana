// SPDX-License-Identifier: Apache-2.0
//
// Full lifecycle test for the separately built GPL Manifest fork. Run the
// local stack with the fork loaded at MANIFEST_PROGRAM_ID, then:
//
//   pnpm rollup:manifest-fork

// This is intentionally separate from tests/manifest-ephemeral.ts. That test
// proves upstream compatibility on public devnet; this one proves Erodoro's
// additive PDA/delegation instructions and exact vault conservation.

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
  MAGICBLOCK_DELEGATION_PROGRAM_ID,
  OrderType,
  claimManifestSeatIx,
  commitManifestMarketIx,
  createManifestMarketIxs,
  delegateManifestMarketIx,
  delegateManifestTokensIxs,
  exitManifestMarketIx,
  loadManifestMarket,
  manifestCancelIx,
  manifestClaimIxs,
  manifestDepositIxs,
  manifestOrderIx,
  manifestVaultPda,
  prepareManifestMarketCustodyIxs,
} from "../web/lib/manifest";

const BASE_URL = process.env.PROVIDER_ENDPOINT ?? "http://127.0.0.1:8899";
const ER_URL = process.env.EPHEMERAL_PROVIDER_ENDPOINT ?? "http://127.0.0.1:7799";
const MANIFEST_PROGRAM_ID = new PublicKey(
  process.env.MANIFEST_PROGRAM_ID ?? "MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms",
);
const PUBLIC_DEVNET = process.env.PUBLIC_DEVNET === "1";
const TRADE_ONLY = process.env.TRADE_ONLY === "1";
const DECIMALS = 6;
const UNIT = BigInt(1_000_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assert: Chai.AssertStatic = chai.assert;

function loadPayer() {
  const walletPath =
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
}

async function sendToRollup(
  connection: Connection,
  instructions: TransactionInstruction[],
  signer: Keypair,
) {
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = signer.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  transaction.sign(signer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
  });
  for (let attempt = 0; attempt < 160; attempt++) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) {
      const landed = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      throw new Error(
        `rollup rejected ${JSON.stringify(status.err)}\n${(landed?.meta?.logMessages ?? []).join("\n")}`,
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    await sleep(250);
  }
  throw new Error(`rollup transaction ${signature} did not confirm`);
}

async function waitForOwner(
  connection: Connection,
  account: PublicKey,
  owner: PublicKey,
  label: string,
) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const info = await connection.getAccountInfo(account, "confirmed");
    if (info?.owner.equals(owner)) return;
    await sleep(250);
  }
  throw new Error(`${label} never became owned by ${owner}`);
}

describe("Manifest fork on a MagicBlock rollup", function () {
  this.timeout(600_000);
  const base = new Connection(BASE_URL, "confirmed");
  const rollup = new Connection(ER_URL, "confirmed");
  const payer = loadPayer();
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  it(
    TRADE_ONLY
      ? "matches and cancels through the public MagicBlock validator"
      : "matches, cancels, commits, exits, and conserves every token",
    async function () {
    for (const [name, connection] of [
      ["base", base],
      ["rollup", rollup],
    ] as const) {
      try {
        await connection.getVersion();
      } catch {
        this.skip();
        throw new Error(`${name} validator is unavailable`);
      }
    }

    if (PUBLIC_DEVNET) {
      await sendAndConfirmTransaction(
        base,
        new Transaction().add(
          ...[maker, taker].map((signer) =>
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: signer.publicKey,
              lamports: 100_000_000,
            }),
          ),
        ),
        [payer],
      );
    } else {
      for (const signer of [payer, maker, taker]) {
        const signature = await base.requestAirdrop(signer.publicKey, 10_000_000_000);
        await base.confirmTransaction(signature, "confirmed");
      }
    }

    const baseMint = await createMint(base, payer, payer.publicKey, null, DECIMALS);
    const quoteMint = await createMint(base, payer, payer.publicKey, null, DECIMALS);
    const makerBase = await createAssociatedTokenAccount(
      base,
      payer,
      baseMint,
      maker.publicKey,
    );
    const makerQuote = await createAssociatedTokenAccount(
      base,
      payer,
      quoteMint,
      maker.publicKey,
    );
    const takerBase = await createAssociatedTokenAccount(
      base,
      payer,
      baseMint,
      taker.publicKey,
    );
    const takerQuote = await createAssociatedTokenAccount(
      base,
      payer,
      quoteMint,
      taker.publicKey,
    );
    await mintTo(base, payer, baseMint, makerBase, payer, 10n * UNIT);
    await mintTo(base, payer, quoteMint, takerQuote, payer, 100n * UNIT);

    const created = createManifestMarketIxs({
      payer: payer.publicKey,
      baseMint,
      quoteMint,
      maturityTimestamp: BigInt(Math.floor(Date.now() / 1_000) + 86_400),
      programId: MANIFEST_PROGRAM_ID,
    });
    await sendAndConfirmTransaction(base, new Transaction().add(...created.ixs), [payer]);

    const identity = await (rollup as any)._rpcRequest("getIdentity", []);
    const validator = new PublicKey(identity.result.identity);
    // The maker joins before activation. The taker deliberately joins after
    // delegation below, proving that an always-live market is not restricted
    // to traders known when the operator starts the session.
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        claimManifestSeatIx(maker.publicKey, created.market, MANIFEST_PROGRAM_ID),
      ),
      [maker],
    );
    const legacyAmount = Buffer.alloc(8);
    legacyAmount.writeBigUInt64LE(UNIT);
    const legacyDeposit = new TransactionInstruction({
      programId: MANIFEST_PROGRAM_ID,
      keys: [
        { pubkey: maker.publicKey, isSigner: true, isWritable: true },
        { pubkey: created.market, isSigner: false, isWritable: true },
        { pubkey: makerBase, isSigner: false, isWritable: true },
        {
          pubkey: manifestVaultPda(created.market, baseMint, MANIFEST_PROGRAM_ID),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: baseMint, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([2]), legacyAmount, Buffer.from([0])]),
    });
    let legacyRejected = false;
    try {
      await sendAndConfirmTransaction(base, new Transaction().add(legacyDeposit), [maker]);
    } catch (error) {
      legacyRejected = true;
      assert.include(String(error), "custom program error: 0x1d");
    }
    assert.isTrue(legacyRejected, "legacy custody must be disabled for canonical markets");
    for (const mint of [baseMint, quoteMint]) {
      const setup = await prepareManifestMarketCustodyIxs({
        connection: base,
        payer: payer.publicKey,
        market: created.market,
        mints: [mint],
        validator,
      });
      await sendAndConfirmTransaction(base, new Transaction().add(...setup), [payer]);
    }
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        ...(await delegateManifestTokensIxs({
          connection: base,
          payer: maker.publicKey,
          mint: baseMint,
          amountAtoms: 10n * UNIT,
          validator,
        })),
      ),
      [maker],
    );
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        ...(await delegateManifestTokensIxs({
          connection: base,
          payer: taker.publicKey,
          mint: quoteMint,
          amountAtoms: 100n * UNIT,
          validator,
        })),
      ),
      [taker],
    );
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        await delegateManifestMarketIx({
          payer: payer.publicKey,
          market: created.market,
          validator,
          programId: MANIFEST_PROGRAM_ID,
        }),
      ),
      [payer],
    );
    await waitForOwner(
      base,
      created.market,
      MAGICBLOCK_DELEGATION_PROGRAM_ID,
      "delegated L1 market",
    );
    await waitForOwner(
      rollup,
      created.market,
      MANIFEST_PROGRAM_ID,
      "rollup market clone",
    );

    await sendToRollup(
      rollup,
      [claimManifestSeatIx(taker.publicKey, created.market, MANIFEST_PROGRAM_ID)],
      taker,
    );
    const joinedAfterActivation = await loadManifestMarket(
      rollup,
      created.market,
      MANIFEST_PROGRAM_ID,
    );
    assert.isTrue(
      joinedAfterActivation.market.hasSeat(taker.publicKey),
      "a new trader can claim a seat after MagicBlock activation",
    );

    for (const [address, expected, label] of [
      [getAssociatedTokenAddressSync(baseMint, maker.publicKey), 10n * UNIT, "maker base"],
      [getAssociatedTokenAddressSync(quoteMint, taker.publicKey), 100n * UNIT, "taker quote"],
    ] as const) {
      for (let attempt = 0; attempt < 160; attempt++) {
        try {
          if ((await getAccount(rollup, address)).amount === expected) break;
        } catch {}
        if (attempt === 159) throw new Error(`${label} projection never became ready`);
        await sleep(250);
      }
    }
    await sendToRollup(
      rollup,
      manifestDepositIxs({
        payer: maker.publicKey,
        market: created.market,
        baseMint,
        quoteMint,
        baseAtoms: 10n * UNIT,
        quoteAtoms: 0n,
        hasSeat: true,
        programId: MANIFEST_PROGRAM_ID,
      }),
      maker,
    );
    await sendToRollup(
      rollup,
      manifestDepositIxs({
        payer: taker.publicKey,
        market: created.market,
        baseMint,
        quoteMint,
        baseAtoms: 0n,
        quoteAtoms: 100n * UNIT,
        hasSeat: true,
        programId: MANIFEST_PROGRAM_ID,
      }),
      taker,
    );

    await sendToRollup(
      rollup,
      [
        manifestOrderIx({
          payer: maker.publicKey,
          market: created.market,
          tokenPrice: 2,
          baseTokens: 5,
          baseDecimals: DECIMALS,
          quoteDecimals: DECIMALS,
          isBid: false,
          programId: MANIFEST_PROGRAM_ID,
        }),
      ],
      maker,
    );
    await sendToRollup(
      rollup,
      [
        manifestOrderIx({
          payer: taker.publicKey,
          market: created.market,
          tokenPrice: 2,
          baseTokens: 5,
          baseDecimals: DECIMALS,
          quoteDecimals: DECIMALS,
          isBid: true,
          orderType: OrderType.ImmediateOrCancel,
          programId: MANIFEST_PROGRAM_ID,
        }),
      ],
      taker,
    );

    let loaded = await loadManifestMarket(rollup, created.market, MANIFEST_PROGRAM_ID);
    assert.lengthOf(loaded.market.asks(), 0, "the taker crossed the maker ask");
    assert.equal(loaded.market.getWithdrawableBalanceTokens(maker.publicKey, true), 5);
    assert.equal(loaded.market.getWithdrawableBalanceTokens(maker.publicKey, false), 10);
    assert.equal(loaded.market.getWithdrawableBalanceTokens(taker.publicKey, true), 5);
    assert.equal(loaded.market.getWithdrawableBalanceTokens(taker.publicKey, false), 90);

    await sendToRollup(
      rollup,
      [
        manifestOrderIx({
          payer: maker.publicKey,
          market: created.market,
          tokenPrice: 3,
          baseTokens: 1,
          baseDecimals: DECIMALS,
          quoteDecimals: DECIMALS,
          isBid: false,
          programId: MANIFEST_PROGRAM_ID,
        }),
      ],
      maker,
    );
    loaded = await loadManifestMarket(rollup, created.market, MANIFEST_PROGRAM_ID);
    assert.lengthOf(loaded.market.asks(), 1);
    let openOrderExitRejected = false;
    try {
      await sendToRollup(
        rollup,
        [
          exitManifestMarketIx(
            payer.publicKey,
            created.market,
            baseMint,
            quoteMint,
            validator,
            MANIFEST_PROGRAM_ID,
          ),
        ],
        payer,
      );
    } catch (error) {
      openOrderExitRejected = true;
      assert.include(String(error), '"Custom":30');
    }
    assert.isTrue(openOrderExitRejected, "exit with locked order balances must fail");
    await sendToRollup(
      rollup,
      [
        manifestCancelIx(
          maker.publicKey,
          created.market,
          BigInt(loaded.market.asks()[0].sequenceNumber.toString()),
          MANIFEST_PROGRAM_ID,
        ),
      ],
      maker,
    );

    // The public deployment now accepts the fee-vault exit ABI (proven by
    // behavior on devnet 2026-09-12: exit plus L1 claims pass against the
    // canonical ephemeral-SPL deployment). Keep the public deployment test
    // useful and explicit. Local/full-stack CI continues through commit, exit
    // and claims.
    if (TRADE_ONLY) return;

    await sendToRollup(
      rollup,
      [commitManifestMarketIx(payer.publicKey, created.market, MANIFEST_PROGRAM_ID)],
      payer,
    );
    const exitIx = exitManifestMarketIx(
      payer.publicKey,
      created.market,
      baseMint,
      quoteMint,
      validator,
      MANIFEST_PROGRAM_ID,
    );
    const exitInfos = await rollup.getMultipleAccountsInfo(
      exitIx.keys.map((key) => key.pubkey),
    );
    exitInfos.forEach((info, index) => {
      assert.isNotNull(
        info,
        `exit account ${index} ${exitIx.keys[index].pubkey.toBase58()} is missing on ER`,
      );
    });
    await sendToRollup(
      rollup,
      [exitIx],
      payer,
    );
    await waitForOwner(
      base,
      created.market,
      MANIFEST_PROGRAM_ID,
      "restored L1 market",
    );

    loaded = await loadManifestMarket(base, created.market, MANIFEST_PROGRAM_ID);
    assert.lengthOf(loaded.market.openOrders(), 0, "cancel survived the commit");
    assert.isFalse(loaded.session.active, "undelegation callback cleared active state");

    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        ...manifestClaimIxs({
          payer: maker.publicKey,
          market: created.market,
          mintsAndAmounts: [
            [baseMint, 5n * UNIT],
            [quoteMint, 10n * UNIT],
          ],
          programId: MANIFEST_PROGRAM_ID,
        }),
      ),
      [maker],
    );
    await sendAndConfirmTransaction(
      base,
      new Transaction().add(
        ...manifestClaimIxs({
          payer: taker.publicKey,
          market: created.market,
          mintsAndAmounts: [
            [baseMint, 5n * UNIT],
            [quoteMint, 90n * UNIT],
          ],
          programId: MANIFEST_PROGRAM_ID,
        }),
      ),
      [taker],
    );

    assert.equal((await getAccount(base, makerBase)).amount, 5n * UNIT);
    assert.equal((await getAccount(base, makerQuote)).amount, 10n * UNIT);
    assert.equal((await getAccount(base, takerBase)).amount, 5n * UNIT);
    assert.equal((await getAccount(base, takerQuote)).amount, 90n * UNIT);
    let doubleClaimRejected = false;
    try {
      await sendAndConfirmTransaction(
        base,
        new Transaction().add(
          ...manifestClaimIxs({
            payer: maker.publicKey,
            market: created.market,
            mintsAndAmounts: [[baseMint, UNIT]],
            programId: MANIFEST_PROGRAM_ID,
          }),
        ),
        [maker],
      );
    } catch {
      doubleClaimRejected = true;
    }
    assert.isTrue(doubleClaimRejected, "a settled balance cannot be claimed twice");
    },
  );
});
