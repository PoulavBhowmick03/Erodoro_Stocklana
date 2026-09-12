// SPDX-License-Identifier: Apache-2.0
//
// Pure decoder for the Pyth Solana Receiver's `PriceUpdateV2` account, plus the
// exponent scaling the settlement math uses.
//
// Plain JS rather than TypeScript so `scripts/check-oracle-decoder.mjs` can
// import the *same* code the app runs and check it against the Rust golden
// vectors at build time. A second implementation checked against a second set
// of fixtures would prove nothing about what ships.
//
// Mirrors `programs/oracle-adapter/src/pyth.rs`.

/** `sha256("account:PriceUpdateV2")[..8]`, written by the Pyth receiver. */
export const PRICE_UPDATE_V2_DISCRIMINATOR = Uint8Array.from([
  34, 241, 35, 99, 157, 126, 244, 205,
]);

/** base58 `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. */
export const PYTH_RECEIVER_ID = Uint8Array.from([
  0x0c, 0xb7, 0xfa, 0xbb, 0x52, 0xf7, 0xa6, 0x48, 0xbb, 0x5b, 0x31, 0x7d, 0x9a, 0x01, 0x8b, 0x90,
  0x57, 0xcb, 0x02, 0x47, 0x74, 0xfa, 0xfe, 0x01, 0xe6, 0xc4, 0xdf, 0x98, 0xcc, 0x38, 0x58, 0x81,
]);

/**
 * Decode a `PriceUpdateV2` account.
 *
 * The one thing this must not do is read fixed offsets. `VerificationLevel` is
 * a borsh enum encoding as one byte for `Full` and two for `Partial`, so every
 * field after it shifts by one depending on how the update was verified. A
 * decoder that assumed either case would silently misread the other — and
 * `Full` is the case production actually posts.
 *
 * Trailing bytes are tolerated: the receiver allocates for the longest
 * verification level, so a `Full` update arrives in an account one byte larger
 * than it needs. Demanding an exact length would reject every fully-verified
 * update in production.
 */
export function decodePriceUpdateV2(data) {
  if (!(data instanceof Uint8Array)) data = Uint8Array.from(data);
  if (data.length <= 8) throw new Error("account too short");
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PRICE_UPDATE_V2_DISCRIMINATOR[i]) {
      throw new Error("not a PriceUpdateV2 account");
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;

  const need = (n) => {
    if (o + n > data.length) throw new Error("account truncated");
  };

  need(32);
  const writeAuthority = data.slice(o, o + 32);
  o += 32;

  need(1);
  const tag = data[o++];
  let numSignatures = null;
  if (tag === 0) {
    need(1);
    numSignatures = data[o++];
  } else if (tag !== 1) {
    throw new Error(`unknown verification level ${tag}`);
  }

  need(32);
  const feedId = data.slice(o, o + 32);
  o += 32;
  need(8);
  const price = view.getBigInt64(o, true);
  o += 8;
  need(8);
  const conf = view.getBigUint64(o, true);
  o += 8;
  need(4);
  const exponent = view.getInt32(o, true);
  o += 4;
  need(8);
  const publishTime = view.getBigInt64(o, true);
  o += 8;
  need(8);
  const prevPublishTime = view.getBigInt64(o, true);
  o += 8;
  need(8);
  const emaPrice = view.getBigInt64(o, true);
  o += 8;
  need(8);
  const emaConf = view.getBigUint64(o, true);
  o += 8;
  need(8);
  const postedSlot = view.getBigUint64(o, true);

  return {
    writeAuthority,
    verificationLevel: tag === 1 ? { full: true } : { partial: numSignatures },
    feedId,
    price,
    conf,
    exponent,
    publishTime,
    prevPublishTime,
    emaPrice,
    emaConf,
    postedSlot,
  };
}

/** Whether an update clears a signature floor. `Full` clears any floor. */
export function meetsFloor(verificationLevel, minSignatures) {
  if (verificationLevel.full) return true;
  return verificationLevel.partial >= minSignatures;
}

export const MAX_DECIMALS = 18;

/**
 * Turn Pyth's signed exponent into the unsigned decimal count the settlement
 * math works in. Mirrors `oracle_adapter::scale_from_expo`.
 *
 * A negative exponent maps straight across: `-8` means the integer carries 8
 * decimals. A non-negative exponent means the integer is coarser than one unit,
 * so it is materialized at 0 decimals rather than pretending to a precision it
 * does not have.
 */
export function scaleFromExpo(price, expo) {
  price = BigInt(price);
  if (expo <= 0) {
    const decimals = Math.abs(expo);
    if (decimals > MAX_DECIMALS) throw new Error("oracle decimals invalid");
    return [price, decimals];
  }
  if (expo > MAX_DECIMALS) throw new Error("oracle decimals invalid");
  return [price * 10n ** BigInt(expo), 0];
}

/** Render an integer-and-decimals price without going through a float. */
export function formatQuote(price, decimals, places = 2) {
  const neg = price < 0n;
  const abs = neg ? -price : price;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr =
    decimals === 0 ? "" : frac.toString().padStart(decimals, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole.toString()}${fracStr ? `.${fracStr}` : ""}`;
}
