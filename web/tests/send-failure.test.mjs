import assert from "node:assert/strict";
import test from "node:test";

import { reportSendFailure } from "../lib/send-failure.ts";

const helpers = {
  isWalletRejection: () => false,
  isTransactionExpired: () => false,
  explainError: (error) => String(error?.message ?? error),
};

for (const message of [
  "Transaction blocked until the configured Solana network is verified.",
  "Pick a test key or connect a wallet first.",
]) {
  test(`early send failure reaches the composed flow: ${message}`, () => {
    const error = new Error(message);
    let observedError;
    let observedState;

    const result = reportSendFailure(error, {
      onError: (received) => {
        observedError = received;
      },
      update: (state) => {
        observedState = state;
      },
      helpers,
    });

    assert.equal(result, null);
    assert.equal(observedError, error);
    assert.deepEqual(observedState, { kind: "error", message });
  });
}
