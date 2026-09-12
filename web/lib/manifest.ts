import {
  Market,
  OrderType,
  createBatchUpdateInstruction,
  toMantissaAndExponent,
  type RestingOrder,
} from "@bonasa-tech/manifest-sdk";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  deriveVault,
  deriveVaultAta,
  initEphemeralAtaIx,
  initVaultAtaIx,
  initVaultIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";

export { Market, OrderType, type RestingOrder };

export const MAGICBLOCK_DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);
export const MAGICBLOCK_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111",
);
export const MAGICBLOCK_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111",
);

/**
 * The compatible Manifest fork is deployed separately because its core program
 * is GPL-3.0. No stock-program fallback is allowed: stock Manifest cannot
 * delegate its writable market account to MagicBlock.
 */
export const MANIFEST_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MANIFEST_PROGRAM_ID ||
    "HTBtzS8fV9Bw1pGRQZEZqYtu49jJLLUjU5msQWaUKfBE",
);

export const MANIFEST_MARKET_BLOCKS = 96;
const SESSION_AUTHORITY_OFFSET = 192;
const SESSION_MATURITY_OFFSET = 224;
const SESSION_ACTIVE_OFFSET = 232;
const SESSION_CUSTODY_OFFSET = 240;

const u32 = (value: number) => {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
};

const u64 = (value: bigint) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
};

const i64 = (value: bigint) => {
  const data = Buffer.alloc(8);
  data.writeBigInt64LE(value);
  return data;
};

export function manifestMarketPda(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer()],
    programId,
  )[0];
}

export function manifestVaultPda(
  market: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer(), mint.toBuffer()],
    programId,
  )[0];
}

export type ManifestSession = {
  authority: PublicKey;
  maturityTimestamp: bigint;
  active: boolean;
  ephemeralCustody: boolean;
};

export async function loadManifestMarket(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
): Promise<{ market: Market; session: ManifestSession }> {
  const response = await connection.getAccountInfoAndContext(
    address,
    "confirmed",
  );
  const account = response.value;
  if (!account) throw new Error(`Manifest market ${address} is missing`);
  if (!account.owner.equals(programId)) {
    throw new Error(`Manifest market ${address} is owned by ${account.owner}`);
  }
  if (account.data.length < 256)
    throw new Error("Manifest market data is truncated");
  return {
    market: Market.loadFromBuffer({
      address,
      buffer: account.data,
      slot: response.context.slot,
    }),
    session: {
      authority: new PublicKey(
        account.data.subarray(
          SESSION_AUTHORITY_OFFSET,
          SESSION_MATURITY_OFFSET,
        ),
      ),
      maturityTimestamp: account.data.readBigInt64LE(SESSION_MATURITY_OFFSET),
      active: account.data.readBigUInt64LE(SESSION_ACTIVE_OFFSET) === BigInt(1),
      ephemeralCustody:
        account.data.readBigUInt64LE(SESSION_CUSTODY_OFFSET) === BigInt(1),
    },
  };
}

export function createManifestMarketIxs({
  payer,
  baseMint,
  quoteMint,
  maturityTimestamp,
  programId,
}: {
  payer: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  maturityTimestamp: bigint;
  programId: PublicKey;
}) {
  const market = manifestMarketPda(baseMint, quoteMint, programId);
  const create = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      {
        pubkey: manifestVaultPda(market, baseMint, programId),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: manifestVaultPda(market, quoteMint, programId),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // Erodoro's claim and cash mints are classic SPL, but Manifest keeps the
      // Token-2022 program in the stable create-market account ABI.
      {
        pubkey: TOKEN_2022_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.concat([Buffer.from([14]), i64(maturityTimestamp)]),
  });
  const expand = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([5]), u32(MANIFEST_MARKET_BLOCKS)]),
  });
  return { market, ixs: [create, expand] };
}

export function claimManifestSeatIx(
  payer: PublicKey,
  market: PublicKey,
  programId: PublicKey,
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function balanceIx(
  discriminator: 18 | 19,
  payer: PublicKey,
  market: PublicKey,
  mint: PublicKey,
  amountAtoms: bigint,
  programId: PublicKey,
) {
  const traderToken = getAssociatedTokenAddressSync(mint, payer);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: traderToken, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(mint, market, true),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // DepositParams and WithdrawParams are amount_atoms + Option<u32> hint.
    data: Buffer.concat([
      Buffer.from([discriminator]),
      u64(amountAtoms),
      Buffer.from([0]),
    ]),
  });
}

export function manifestDepositIxs({
  payer,
  market,
  baseMint,
  quoteMint,
  baseAtoms,
  quoteAtoms,
  hasSeat,
  programId,
}: {
  payer: PublicKey;
  market: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAtoms: bigint;
  quoteAtoms: bigint;
  hasSeat: boolean;
  programId: PublicKey;
}) {
  const ixs: TransactionInstruction[] = [];
  if (!hasSeat) {
    throw new Error("Claim a Manifest seat on Solana before fast mode starts");
  }
  for (const [mint, amount] of [
    [baseMint, baseAtoms],
    [quoteMint, quoteAtoms],
  ] as const) {
    if (amount === BigInt(0)) continue;
    ixs.push(balanceIx(18, payer, market, mint, amount, programId));
  }
  return ixs;
}

export function manifestWithdrawIxs({
  payer,
  market,
  baseMint,
  quoteMint,
  baseAtoms,
  quoteAtoms,
  programId,
}: Omit<Parameters<typeof manifestDepositIxs>[0], "hasSeat">) {
  return (
    [
      [baseMint, baseAtoms],
      [quoteMint, quoteAtoms],
    ] as const
  )
    .filter(([, amount]) => amount > BigInt(0))
    .map(([mint, amount]) =>
      balanceIx(19, payer, market, mint, amount, programId),
    );
}

/** Prepare a trader's real SPL balance for projection onto the rollup. */
export async function delegateManifestTokensIxs({
  connection,
  payer,
  mint,
  amountAtoms,
  validator,
}: {
  connection: Connection;
  payer: PublicKey;
  mint: PublicKey;
  amountAtoms: bigint;
  validator: PublicKey;
}) {
  const [vault] = deriveVault(mint);
  const [eata] = deriveEphemeralAta(payer, mint);
  const eataInfo = await connection.getAccountInfo(eata);
  const alreadyDelegated =
    eataInfo?.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID) ?? false;
  return delegateSpl(payer, mint, amountAtoms, {
    payer,
    validator,
    tokenProgram: TOKEN_PROGRAM_ID,
    initIfMissing: !eataInfo,
    initVaultIfMissing: !(await connection.getAccountInfo(vault)),
    initAtasIfMissing: true,
    // The shuttle/idempotent path is only needed for topping up an already
    // delegated balance. First delegation uses the direct, owner-funded path.
    idempotent: alreadyDelegated,
  });
}

/**
 * Initialize and delegate the market PDA's empty eATA for each mint. The PDA
 * never signs on L1: only the payer creates these empty custody records, and
 * Manifest later signs transfers/claims with the canonical market seeds.
 */
export async function prepareManifestMarketCustodyIxs({
  connection,
  payer,
  market,
  mints,
  validator,
}: {
  connection: Connection;
  payer: PublicKey;
  market: PublicKey;
  mints: PublicKey[];
  validator: PublicKey;
}) {
  const ixs: TransactionInstruction[] = [];
  for (const mint of mints) {
    const [vault] = deriveVault(mint);
    const vaultAta = deriveVaultAta(mint, vault);
    const [eata] = deriveEphemeralAta(market, mint);
    const [vaultInfo, eataInfo] = await connection.getMultipleAccountsInfo([
      vault,
      eata,
    ]);
    if (!vaultInfo) {
      ixs.push(
        initVaultIx(vault, mint, payer),
        initVaultAtaIx(payer, vaultAta, vault, mint),
      );
    }
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        getAssociatedTokenAddressSync(mint, market, true),
        market,
        mint,
      ),
    );
    if (!eataInfo) ixs.push(initEphemeralAtaIx(eata, market, mint, payer));
    if (!eataInfo?.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID)) {
      ixs.push(delegateEphemeralAtaIx(payer, eata, validator));
    }
  }
  return ixs;
}

export function manifestClaimIxs({
  payer,
  market,
  mintsAndAmounts,
  programId,
}: {
  payer: PublicKey;
  market: PublicKey;
  mintsAndAmounts: readonly (readonly [PublicKey, bigint])[];
  programId: PublicKey;
}) {
  return mintsAndAmounts
    .filter(([, amount]) => amount > BigInt(0))
    .map(([mint, amount]) => {
      const [eata] = deriveEphemeralAta(market, mint);
      const [vault] = deriveVault(mint);
      return new TransactionInstruction({
        programId,
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: eata, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          {
            pubkey: deriveVaultAta(mint, vault),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: getAssociatedTokenAddressSync(mint, payer),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([20]), u64(amount), Buffer.from([0])]),
      });
    });
}

export function manifestOrderIx({
  payer,
  market,
  tokenPrice,
  baseTokens,
  baseDecimals,
  quoteDecimals,
  isBid,
  orderType = OrderType.Limit,
  programId,
}: {
  payer: PublicKey;
  market: PublicKey;
  tokenPrice: number;
  baseTokens: number;
  baseDecimals: number;
  quoteDecimals: number;
  isBid: boolean;
  orderType?: OrderType;
  programId: PublicKey;
}) {
  const atomPrice = tokenPrice * 10 ** (quoteDecimals - baseDecimals);
  const { priceMantissa, priceExponent } = toMantissaAndExponent(atomPrice, 8);
  return createBatchUpdateInstruction(
    { payer, market },
    {
      params: {
        traderIndexHint: null,
        cancels: [],
        orders: [
          {
            baseAtoms: BigInt(Math.floor(baseTokens * 10 ** baseDecimals)),
            priceMantissa,
            priceExponent,
            isBid,
            lastValidSlot: 0,
            orderType,
          },
        ],
      },
    },
    programId,
  );
}

export function manifestCancelIx(
  payer: PublicKey,
  market: PublicKey,
  sequenceNumber: bigint,
  programId: PublicKey,
) {
  return createBatchUpdateInstruction(
    { payer, market },
    {
      params: {
        traderIndexHint: null,
        cancels: [
          { orderSequenceNumber: sequenceNumber, orderIndexHint: null },
        ],
        orders: [],
      },
    },
    programId,
  );
}

export async function delegateManifestMarketIx({
  payer,
  market,
  validator,
  programId,
}: {
  payer: PublicKey;
  market: PublicKey;
  validator: PublicKey;
  programId: PublicKey;
}) {
  const buffer = PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), market.toBuffer()],
    programId,
  )[0];
  const record = PublicKey.findProgramAddressSync(
    [Buffer.from("delegation"), market.toBuffer()],
    MAGICBLOCK_DELEGATION_PROGRAM_ID,
  )[0];
  const metadata = PublicKey.findProgramAddressSync(
    [Buffer.from("delegation-metadata"), market.toBuffer()],
    MAGICBLOCK_DELEGATION_PROGRAM_ID,
  )[0];
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      {
        pubkey: MAGICBLOCK_DELEGATION_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: validator, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([15]), u32(1_000)]),
  });
}

function sessionIx(
  discriminator: 16,
  payer: PublicKey,
  market: PublicKey,
  programId: PublicKey,
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([discriminator]),
  });
}

export const commitManifestMarketIx = (
  payer: PublicKey,
  market: PublicKey,
  programId: PublicKey,
) => sessionIx(16, payer, market, programId);

export const exitManifestMarketIx = (
  payer: PublicKey,
  market: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  validator: PublicKey,
  programId: PublicKey,
) => {
  const magicFeeVault = PublicKey.findProgramAddressSync(
    [Buffer.from("magic-fee-vault"), validator.toBuffer()],
    MAGICBLOCK_DELEGATION_PROGRAM_ID,
  )[0];
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: getAssociatedTokenAddressSync(baseMint, market, true),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveEphemeralAta(market, baseMint)[0],
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: getAssociatedTokenAddressSync(quoteMint, market, true),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveEphemeralAta(market, quoteMint)[0],
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: magicFeeVault, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([17]),
  });
};
