import type { OracleState } from "./use-oracle";

export const UNSAFE_ORACLE_MESSAGE =
  "This market currently accepts a price with no minimum signature threshold. Do not use assets with real value.";

/** A failed quote read must not hide an unsafe configuration we already read. */
export function hasUnsafeOracleConfiguration(state: OracleState) {
  return "config" in state && state.config?.minVerificationSignatures === 0;
}
