import test from "node:test";
import assert from "node:assert/strict";

import {
  hasUnsafeOracleConfiguration,
  UNSAFE_ORACLE_MESSAGE,
} from "../lib/oracle-safety.ts";

test("zero signatures is treated as an unsafe oracle configuration", () => {
  assert.equal(
    hasUnsafeOracleConfiguration({
      kind: "ready",
      config: { minVerificationSignatures: 0 },
      quote: {},
    }),
    true,
  );
  assert.match(UNSAFE_ORACLE_MESSAGE, /no minimum signature threshold/i);
  assert.match(UNSAFE_ORACLE_MESSAGE, /Do not use assets with real value/i);
});

test("safe and unread configurations do not show the zero-signature warning", () => {
  assert.equal(
    hasUnsafeOracleConfiguration({
      kind: "ready",
      config: { minVerificationSignatures: 1 },
      quote: {},
    }),
    false,
  );
  assert.equal(hasUnsafeOracleConfiguration({ kind: "loading" }), false);
  assert.equal(hasUnsafeOracleConfiguration({ kind: "unconfigured" }), false);
});

test("a quote error does not hide a zero-signature configuration already read", () => {
  assert.equal(
    hasUnsafeOracleConfiguration({
      kind: "error",
      message: "price source unavailable",
      config: { minVerificationSignatures: 0 },
    }),
    true,
  );
});
