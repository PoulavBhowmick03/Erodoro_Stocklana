/**
 * The BigInt accessors that `buffer@5.7.1` does not have.
 *
 * Node's `Buffer` gained `writeBigUInt64LE` and friends in v12. The browser
 * shim did not until `buffer@6`, and the dependency graph resolves `buffer` to
 * 5.7.1 for the bundle. Every u64 an SDK encodes goes through one of these, so
 * in the built app the first delegation a trader attempts fails with
 * `TypeError: n.writeBigUInt64LE is not a function` — which meant nobody who
 * had not already delegated could place an order at all.
 *
 * Patching rather than forcing the dependency to `buffer@6`: this is a missing
 * method on a shim, the semantics are fully specified, and an override would
 * change the Buffer implementation under every other package that resolved 5.x
 * deliberately. Each function is only installed if it is genuinely absent, so
 * an environment with a complete Buffer is untouched.
 *
 * `tests/buffer-compat.test.mjs` checks each implementation byte-for-byte
 * against Node's native Buffer, including the boundary values where a naive
 * 32-bit split goes wrong.
 */

const TWO_64 = BigInt("0x10000000000000000");
const INT64_MAX = BigInt("0x7fffffffffffffff");

/** Anything indexable by byte. Buffer and Uint8Array both qualify. */
type Bytes = { [index: number]: number; length: number };

/** Range checks mirror Node's, so a bug surfaces here rather than as bad bytes. */
function boundedUnsigned(value: bigint, name: string): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} expects a bigint`);
  if (value < BigInt(0) || value >= TWO_64) {
    throw new RangeError(`${name}: value out of range`);
  }
  return value;
}

function boundedSigned(value: bigint, name: string): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} expects a bigint`);
  if (value > INT64_MAX || value < -INT64_MAX - BigInt(1)) {
    throw new RangeError(`${name}: value out of range`);
  }
  // Two's complement, so the signed and unsigned writers share one path.
  return value < BigInt(0) ? value + TWO_64 : value;
}

function checkRoom(target: Bytes, offset: number, name: string) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 8 > target.length) {
    throw new RangeError(`${name}: offset out of range`);
  }
}

const BYTE = BigInt(0xff);
const EIGHT = BigInt(8);

function writeLE(target: Bytes, value: bigint, offset: number) {
  for (let i = 0; i < 8; i += 1) {
    target[offset + i] = Number((value >> (EIGHT * BigInt(i))) & BYTE);
  }
  return offset + 8;
}

function writeBE(target: Bytes, value: bigint, offset: number) {
  for (let i = 0; i < 8; i += 1) {
    target[offset + i] = Number((value >> (EIGHT * BigInt(7 - i))) & BYTE);
  }
  return offset + 8;
}

function readLE(target: Bytes, offset: number) {
  let value = BigInt(0);
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << EIGHT) | BigInt(target[offset + i] & 0xff);
  }
  return value;
}

function readBE(target: Bytes, offset: number) {
  let value = BigInt(0);
  for (let i = 0; i < 8; i += 1) {
    value = (value << EIGHT) | BigInt(target[offset + i] & 0xff);
  }
  return value;
}

export const bufferCompat = {
  writeBigUInt64LE(this: Bytes, value: bigint, offset = 0): number {
    checkRoom(this, offset, "writeBigUInt64LE");
    return writeLE(this, boundedUnsigned(value, "writeBigUInt64LE"), offset);
  },
  writeBigUInt64BE(this: Bytes, value: bigint, offset = 0): number {
    checkRoom(this, offset, "writeBigUInt64BE");
    return writeBE(this, boundedUnsigned(value, "writeBigUInt64BE"), offset);
  },
  writeBigInt64LE(this: Bytes, value: bigint, offset = 0): number {
    checkRoom(this, offset, "writeBigInt64LE");
    return writeLE(this, boundedSigned(value, "writeBigInt64LE"), offset);
  },
  writeBigInt64BE(this: Bytes, value: bigint, offset = 0): number {
    checkRoom(this, offset, "writeBigInt64BE");
    return writeBE(this, boundedSigned(value, "writeBigInt64BE"), offset);
  },
  readBigUInt64LE(this: Bytes, offset = 0): bigint {
    checkRoom(this, offset, "readBigUInt64LE");
    return readLE(this, offset);
  },
  readBigUInt64BE(this: Bytes, offset = 0): bigint {
    checkRoom(this, offset, "readBigUInt64BE");
    return readBE(this, offset);
  },
  readBigInt64LE(this: Bytes, offset = 0): bigint {
    const raw = bufferCompat.readBigUInt64LE.call(this, offset);
    return raw > INT64_MAX ? raw - TWO_64 : raw;
  },
  readBigInt64BE(this: Bytes, offset = 0): bigint {
    const raw = bufferCompat.readBigUInt64BE.call(this, offset);
    return raw > INT64_MAX ? raw - TWO_64 : raw;
  },
};

/**
 * Install the missing accessors on every byte-array prototype that lacks them.
 *
 * `Uint8Array` is the one that matters. The bundled SDKs build instruction data
 * as plain `Uint8Array`s and then call Node `Buffer` methods on them, and in
 * the browser there is no global `Buffer` at all — so patching `Buffer` alone
 * fixed nothing. `Buffer` extends `Uint8Array`, so covering the base class
 * covers both.
 *
 * Extending a builtin prototype is not free, and the justification is narrow:
 * these eight names are defined by Node, absent from `Uint8Array` by
 * specification, semantically correct for any byte array, installed only when
 * missing, and non-enumerable so nothing that iterates keys can see them.
 *
 * Returns what it added, so a caller can assert the shim did something rather
 * than silently doing nothing.
 */
export function installBufferCompat(
  target?: { prototype: Record<string, unknown> } | null,
): string[] {
  const targets: { prototype: Record<string, unknown> }[] = [];
  if (target) {
    targets.push(target);
  } else {
    targets.push(Uint8Array as unknown as { prototype: Record<string, unknown> });
    const globalBuffer = (globalThis as { Buffer?: { prototype: Record<string, unknown> } })
      .Buffer;
    if (globalBuffer?.prototype) targets.push(globalBuffer);
  }

  const added: string[] = [];
  for (const ctor of targets) {
    if (!ctor?.prototype) continue;
    for (const [name, implementation] of Object.entries(bufferCompat)) {
      if (typeof ctor.prototype[name] === "function") continue;
      Object.defineProperty(ctor.prototype, name, {
        value: implementation,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      added.push(name);
    }
  }
  return added;
}
