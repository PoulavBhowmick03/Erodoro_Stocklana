import test from "node:test";
import assert from "node:assert/strict";

import { bufferCompat, installBufferCompat } from "../lib/buffer-compat.ts";

/**
 * Node's Buffer has the real implementations, so it is the oracle: the shim is
 * correct exactly when it produces identical bytes and reads back identical
 * values. Testing it against itself would prove nothing.
 */
const UNSIGNED = [
  0n,
  1n,
  255n,
  256n,
  0xffff_ffffn, // the 32-bit boundary a naive split gets wrong
  0x1_0000_0000n,
  0x1_0000_0001n,
  1_000_000_000_000n, // a realistic lamport/atom amount
  0xffff_ffff_ffff_fffen,
  0xffff_ffff_ffff_ffffn, // u64 max
];

const SIGNED = [
  0n,
  1n,
  -1n,
  255n,
  -256n,
  0xffff_ffffn,
  -0x1_0000_0000n,
  9_223_372_036_854_775_807n, // i64 max
  -9_223_372_036_854_775_808n, // i64 min
];

for (const endian of ["LE", "BE"]) {
  test(`writeBigUInt64${endian} matches Node byte for byte`, () => {
    for (const value of UNSIGNED) {
      const native = Buffer.alloc(8);
      const shimmed = Buffer.alloc(8);
      const nativeEnd = native[`writeBigUInt64${endian}`](value, 0);
      const shimEnd = bufferCompat[`writeBigUInt64${endian}`].call(shimmed, value, 0);
      assert.deepEqual(shimmed, native, `bytes differ for ${value}`);
      assert.equal(shimEnd, nativeEnd, `return offset differs for ${value}`);
    }
  });

  test(`writeBigInt64${endian} matches Node byte for byte`, () => {
    for (const value of SIGNED) {
      const native = Buffer.alloc(8);
      const shimmed = Buffer.alloc(8);
      native[`writeBigInt64${endian}`](value, 0);
      bufferCompat[`writeBigInt64${endian}`].call(shimmed, value, 0);
      assert.deepEqual(shimmed, native, `bytes differ for ${value}`);
    }
  });

  test(`readBigUInt64${endian} round-trips every written value`, () => {
    for (const value of UNSIGNED) {
      const buf = Buffer.alloc(8);
      buf[`writeBigUInt64${endian}`](value, 0);
      assert.equal(bufferCompat[`readBigUInt64${endian}`].call(buf, 0), value);
    }
  });

  test(`readBigInt64${endian} round-trips signed values`, () => {
    for (const value of SIGNED) {
      const buf = Buffer.alloc(8);
      buf[`writeBigInt64${endian}`](value, 0);
      assert.equal(bufferCompat[`readBigInt64${endian}`].call(buf, 0), value);
    }
  });
}

test("a non-zero offset writes where it is told", () => {
  const native = Buffer.alloc(16);
  const shimmed = Buffer.alloc(16);
  native.writeBigUInt64LE(0xdead_beef_cafe_baben, 5);
  bufferCompat.writeBigUInt64LE.call(shimmed, 0xdead_beef_cafe_baben, 5);
  assert.deepEqual(shimmed, native);
  assert.equal(bufferCompat.readBigUInt64LE.call(shimmed, 5), 0xdead_beef_cafe_baben);
});

test("out-of-range values are refused rather than silently truncated", () => {
  const buf = Buffer.alloc(8);
  assert.throws(() => bufferCompat.writeBigUInt64LE.call(buf, -1n, 0), RangeError);
  assert.throws(() => bufferCompat.writeBigUInt64LE.call(buf, 1n << 64n, 0), RangeError);
  assert.throws(() => bufferCompat.writeBigInt64LE.call(buf, 1n << 63n, 0), RangeError);
  assert.throws(() => bufferCompat.writeBigInt64LE.call(buf, -(1n << 63n) - 1n, 0), RangeError);
});

test("a bare Uint8Array produces the same bytes as a Buffer", () => {
  // This is the case that matters: in the browser there is no global Buffer,
  // and the SDKs call these methods on plain Uint8Arrays.
  for (const value of UNSIGNED) {
    const native = Buffer.alloc(8);
    const raw = new Uint8Array(8);
    native.writeBigUInt64LE(value, 0);
    bufferCompat.writeBigUInt64LE.call(raw, value, 0);
    assert.deepEqual(Array.from(raw), Array.from(native), `bytes differ for ${value}`);
    assert.equal(bufferCompat.readBigUInt64LE.call(raw, 0), value);
  }
});

test("writing past the end is refused instead of silently dropping bytes", () => {
  const raw = new Uint8Array(8);
  assert.throws(() => bufferCompat.writeBigUInt64LE.call(raw, 1n, 1), RangeError);
  assert.throws(() => bufferCompat.readBigUInt64LE.call(raw, 4), RangeError);
});

test("installing adds only what is missing", () => {
  // A prototype missing every accessor, standing in for the browser's
  // Uint8Array.
  const bare = { prototype: {} };
  const added = installBufferCompat(bare);
  assert.equal(added.length, 8, "all eight accessors should be installed");
  assert.equal(typeof bare.prototype.writeBigUInt64LE, "function");

  // Installing again is a no-op, so a double import cannot double-patch.
  assert.deepEqual(installBufferCompat(bare), []);
});

test("a complete Buffer is left entirely alone", () => {
  // Node's own Buffer already has all eight; the shim must not replace them.
  const before = Buffer.prototype.writeBigUInt64LE;
  const added = installBufferCompat(Buffer);
  assert.deepEqual(added, []);
  assert.equal(Buffer.prototype.writeBigUInt64LE, before);
});
