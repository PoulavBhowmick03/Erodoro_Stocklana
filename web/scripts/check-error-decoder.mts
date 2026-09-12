// SPDX-License-Identifier: Apache-2.0
//
// The decoder, against the shapes a failure actually arrives in.
//
// Every case below is a real shape this repo produced during the Pinocchio
// ports -- a `SendTransactionError` message, a simulation `err` object, an
// Anchor log line. A decoder that handled one of them and silently returned
// `null` for the rest would leave users staring at hex, which is the state this
// exists to end.
import assert from "node:assert";
import { errorCodeOf, explainError, describeFailure } from "../lib/explain-error.ts";
import { SHARED_ERRORS } from "../lib/error-table.ts";

let checks = 0;
const ok = (label: string) => {
  checks++;
  console.log(`  ok   ${label}`);
};

// The table is positional: Anchor numbers from 6000 by declaration order.
SHARED_ERRORS.forEach((e, i) =>
  assert.equal(e.code, 6000 + i, `${e.name} should be 6000+${i}`),
);
ok(`${SHARED_ERRORS.length} shared variants, contiguous from 6000`);

// Codes derived independently while porting, as a cross-check on the ordering.
for (const [name, code] of [
  ["Unauthorized", 6002],
  ["InvalidStrike", 6005],
  ["MathOverflow", 6021],
  ["InvalidDecimals", 6025],
  ["InvalidParams", 6026],
  ["CreationPaused", 6027],
  ["FeedMismatch", 6035],
] as const) {
  assert.equal(SHARED_ERRORS.find((e) => e.name === name)?.code, code, `${name} moved`);
}
ok("codes match the ones derived during the ports");

const shapes: [string, unknown, number | null][] = [
  ["SendTransactionError text", { message: "custom program error: 0x1793" }, 6035],
  ["simulation err object", { err: { InstructionError: [0, { Custom: 6027 }] } }, 6027],
  ["bare InstructionError", { InstructionError: [0, { Custom: 6002 }] }, 6002],
  ["anchor wrapper", { error: { errorCode: { number: 6026 } } }, 6026],
  ["anchor log line", { logs: ["Program log: AnchorError ... Error Number: 6010."] }, 6010],
  ["not one of ours", new Error("insufficient funds for rent"), null],
];
for (const [label, input, expected] of shapes) {
  assert.equal(errorCodeOf(input), expected, label);
  ok(`decodes ${label}`);
}

assert.equal(
  explainError({ message: "custom program error: 0x1793" }),
  "oracle feed identity does not match the series config",
);
ok("0x1793 explains as a feed mismatch");

// A failure must never render as an empty string: nothing on screen reads as a
// UI bug rather than a rejection.
assert.ok(describeFailure(new Error("")).length > 0);
assert.equal(describeFailure(new Error("rent")), "rent");
ok("an unrecognised failure still says something");

console.log(`\n${checks} checks passed`);
