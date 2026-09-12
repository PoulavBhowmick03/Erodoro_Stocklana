export type SendFailureState =
  | { kind: "cancelled"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "error"; message: string };

export type SendFailureHelpers = {
  isWalletRejection: (error: unknown) => boolean;
  isTransactionExpired: (error: unknown) => boolean;
  explainError: (error: unknown) => string;
};

export function classifySendFailure(
  error: unknown,
  helpers: SendFailureHelpers,
): SendFailureState {
  if (helpers.isWalletRejection(error)) {
    return { kind: "cancelled", message: "Transaction cancelled in your wallet." };
  }
  if (helpers.isTransactionExpired(error)) {
    return {
      kind: "expired",
      message: "This approval expired before it landed. Review it and try again.",
    };
  }
  return { kind: "error", message: helpers.explainError(error) };
}

/** Notify composed flows and the single-send UI about the exact same failure. */
export function reportSendFailure(
  error: unknown,
  options: {
    onError?: (error: unknown) => void;
    update: (state: SendFailureState) => void;
    helpers: SendFailureHelpers;
  },
): null {
  options.onError?.(error);
  options.update(classifySendFailure(error, options.helpers));
  return null;
}
