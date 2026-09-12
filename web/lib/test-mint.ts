"use client";

import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

/**
 * A tokenized share, for devnet.
 *
 * The real ones do not exist here — Backed's xStocks and Ondo's tokens are
 * mainnet only — so testing the protocol on devnet means minting something
 * shaped like them.
 *
 * "Shaped like them" is doing real work. A plain SPL mint would exercise none
 * of what this protocol is actually for: the whole `series` program is built
 * around a collateral mint whose issuer keeps live control. So the defaults
 * here mirror what TSLAx carries on mainnet, verified on-chain:
 *
 *   scaledUiAmount   the multiplier corporate actions move. Backed uses it for
 *                    dividends *and* splits, which is why the strike-adjustment
 *                    path exists at all.
 *   permanentDelegate the issuer's ability to move collateral out of a settled
 *                    vault. The proportional shortfall haircut exists for this.
 *
 * Both are optional here, because a mint without them is also worth testing:
 * it is the case `MintMultipliers::IDENTITY` covers, and it must behave
 * identically to a mint whose multiplier happens to be 1.
 *
 * 8 decimals, matching every xStock.
 */
export const TEST_MINT_DECIMALS = 8;

export type TestMintOptions = {
  /** Corporate-action multiplier. Off means the plain-SPL-shaped case. */
  scaledUiAmount: boolean;
  /**
   * Issuer seizure. Set to the creator, so the drain path can actually be
   * exercised from the same wallet rather than only reasoned about.
   */
  permanentDelegate: boolean;
  /** Whole tokens minted to the creator. */
  amount: number;
};

export type TestMintResult = {
  mint: PublicKey;
  ata: PublicKey;
  extensions: string[];
};

/**
 * Build the instructions for a test collateral mint.
 *
 * Returned rather than sent, so the caller owns the signing story — the mint
 * keypair has to sign alongside the wallet, and hiding that inside a helper
 * makes the failure mode ("why is this asking for two signatures?") harder to
 * read than it needs to be.
 */
export async function buildTestMintIxs(
  connection: Connection,
  payer: PublicKey,
  opts: TestMintOptions,
): Promise<{ ixs: TransactionInstruction[]; mintKeypair: Keypair; result: TestMintResult }> {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const extensionTypes: ExtensionType[] = [];
  const extensions: string[] = [];
  if (opts.scaledUiAmount) {
    extensionTypes.push(ExtensionType.ScaledUiAmountConfig);
    extensions.push("scaledUiAmount");
  }
  if (opts.permanentDelegate) {
    extensionTypes.push(ExtensionType.PermanentDelegate);
    extensions.push("permanentDelegate");
  }

  const len = getMintLen(extensionTypes);
  const lamports = await connection.getMinimumBalanceForRentExemption(len);

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: len,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ];

  // Extensions must be initialized before the mint itself, or Token-2022
  // rejects them — the mint write seals the account's layout.
  if (opts.permanentDelegate) {
    ixs.push(
      createInitializePermanentDelegateInstruction(mint, payer, TOKEN_2022_PROGRAM_ID),
    );
  }
  if (opts.scaledUiAmount) {
    ixs.push(
      createInitializeScaledUiAmountConfigInstruction(
        mint,
        payer, // authority: whoever can later post a split or a dividend
        1, // multiplier starts at 1, exactly as a freshly listed xStock does
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  ixs.push(
    createInitializeMintInstruction(
      mint,
      TEST_MINT_DECIMALS,
      payer, // mint authority
      null, // no freeze authority: one fewer lever than the real thing
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);
  ixs.push(
    createAssociatedTokenAccountInstruction(payer, ata, payer, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(
      mint,
      ata,
      payer,
      BigInt(Math.round(opts.amount * 10 ** TEST_MINT_DECIMALS)),
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  return { ixs, mintKeypair, result: { mint, ata, extensions } };
}

/**
 * Test cash, for the other side of the trade.
 *
 * The order book quotes P and N against a quote mint, and that mint has to be
 * classic SPL: the market's vaults are created with `TOKEN_PROGRAM_ID`, so a
 * Token-2022 mint is rejected outright. The collateral mint above is the
 * opposite, deliberately Token-2022, which is why these cannot be the same
 * helper however similar they look.
 *
 * Devnet has no USDC worth using, so this stands in for it. Six decimals,
 * matching the real thing, because prices in the book are quoted in these units
 * and a mismatch would put every price off by a factor of a hundred.
 *
 * `alsoFund` exists because a two-sided market needs a funded second side, and
 * mint authority stays with whoever created the mint. Without it the buyer key
 * holds a balance of zero and the only trade anyone can make is with themselves.
 */
export const QUOTE_MINT_DECIMALS = 6;

export type QuoteMintResult = { mint: PublicKey; ata: PublicKey; funded: PublicKey[] };

export async function buildQuoteMintIxs(
  connection: Connection,
  payer: PublicKey,
  opts: { amount: number; alsoFund?: PublicKey | null },
): Promise<{ ixs: TransactionInstruction[]; mintKeypair: Keypair; result: QuoteMintResult }> {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const len = getMintLen([]);
  const lamports = await connection.getMinimumBalanceForRentExemption(len);
  const raw = BigInt(Math.round(opts.amount * 10 ** QUOTE_MINT_DECIMALS));

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: len,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint, QUOTE_MINT_DECIMALS, payer, null, TOKEN_PROGRAM_ID),
  ];

  const give = (owner: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
    ixs.push(
      createAssociatedTokenAccountInstruction(payer, ata, owner, mint, TOKEN_PROGRAM_ID),
      createMintToInstruction(mint, ata, payer, raw, [], TOKEN_PROGRAM_ID),
    );
    return ata;
  };

  const ata = give(payer);
  const funded = [payer];
  if (opts.alsoFund && !opts.alsoFund.equals(payer)) {
    give(opts.alsoFund);
    funded.push(opts.alsoFund);
  }

  return { ixs, mintKeypair, result: { mint, ata, funded } };
}
