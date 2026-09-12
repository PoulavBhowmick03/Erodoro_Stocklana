import { MARKET_ERRORS, SHARED_ERRORS, type SharedError } from "./error-table.ts";

type Entry = SharedError;

/**
 * Turn a failed transaction into something a person can act on.
 *
 * Without this a user whose split was refused sees `custom program error:
 * 0x1793` — a hex code, from a program whose IDL carries no error table,
 * because `series`, `factory` and `oracle_adapter` all return
 * `common::OptionsError` and Anchor only emits an IDL `errors` array for errors
 * declared in the program's own crate. `error-table.json` is generated from
 * `common/src/error.rs` to fill that gap; `market` has its own enum and so does
 * carry one.
 *
 * Errors arrive in several shapes depending on where they were raised — a
 * simulation result, a `SendTransactionError`, an Anchor wrapper, or a bare
 * string — so the code is dug out of whichever one turned up rather than
 * assuming a single path.
 */
const SHARED: Entry[] = SHARED_ERRORS;
const MARKET: Entry[] = MARKET_ERRORS;

/** Extract a custom program error code from whatever shape arrived. */
export function errorCodeOf(e: unknown): number | null {
  if (e == null) return null;

  // A simulation result, or an already-parsed InstructionError.
  const asObj = e as {
    InstructionError?: [number, { Custom?: number }];
    err?: { InstructionError?: [number, { Custom?: number }] };
    error?: { errorCode?: { number?: number } };
    code?: number;
    logs?: string[];
    message?: string;
  };
  const instr = asObj.InstructionError ?? asObj.err?.InstructionError;
  if (instr && typeof instr[1]?.Custom === "number") return instr[1].Custom;

  // Anchor wraps its own errors with a numeric code.
  if (typeof asObj.error?.errorCode?.number === "number") {
    return asObj.error.errorCode.number;
  }
  if (typeof asObj.code === "number" && asObj.code >= 6000) return asObj.code;

  // Otherwise dig through the text: logs first, then the message.
  const text = [
    ...(Array.isArray(asObj.logs) ? asObj.logs : []),
    typeof asObj.message === "string" ? asObj.message : "",
    typeof e === "string" ? e : String(e),
  ].join("\n");

  const hex = text.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = text.match(/\bCustom\s*[:(]\s*(\d+)/);
  if (dec) return parseInt(dec[1], 10);
  const anchorNumber = text.match(/Error Number:\s*(\d+)/);
  if (anchorNumber) return parseInt(anchorNumber[1], 10);

  return null;
}

/**
 * A sentence for the user, or `null` when the code is not one of ours.
 *
 * `market` is checked first: it has its own `#[error_code]` enum numbered from
 * 6000, so its codes *collide* with the shared table's. Which table applies
 * depends on which program threw, and the logs are the only place that says.
 */
export function explainError(e: unknown, program?: "market" | "shared"): string | null {
  const code = errorCodeOf(e);
  if (code === null) return null;

  const text = String((e as { logs?: string[] })?.logs?.join("\n") ?? e);
  const looksLikeMarket =
    program === "market" || /FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC/.test(text);

  const tables = looksLikeMarket ? [MARKET, SHARED] : [SHARED, MARKET];
  for (const t of tables) {
    const hit = t.find((x) => x.code === code);
    if (hit) return hit.msg;
  }
  return null;
}

/**
 * What to show when something fails: the protocol's own words if it was the
 * protocol, and the raw text otherwise.
 *
 * Never returns an empty string — a failure that renders as nothing looks like
 * a UI bug rather than a rejection.
 */
export function describeFailure(e: unknown, program?: "market" | "shared"): string {
  const explained = explainError(e, program);
  if (explained) return explained;
  const raw = e instanceof Error ? e.message : String(e);
  return raw.trim() || "The transaction failed for an unknown reason.";
}
