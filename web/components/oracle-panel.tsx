"use client";

import { formatQuote, type OracleState } from "@/lib/use-oracle";
import {
  hasUnsafeOracleConfiguration,
  UNSAFE_ORACLE_MESSAGE,
} from "@/lib/oracle-safety";
import { ORACLE_ADAPTER_PROGRAM } from "@/lib/pdas";
import { AddressLink } from "./ui";
import type { MagicBlockPriceState } from "@/lib/use-magicblock-price";

/**
 * The live quote behind a feed, read straight from the deployed adapter.
 *
 * It reads the same two accounts `series::settle` reads and applies the same
 * feed-id and staleness checks, so what is shown here is what settlement would
 * accept — or refuse. Mounted on a series' trade tab, where the price it will
 * settle against is the thing a trader is pricing off.
 *
 * Staleness is shown rather than hidden. A quote past its configured age is not
 * a display nuance: `settle` rejects it, so a UI that quietly rendered it would
 * be showing a price the protocol will not use.
 */
export function OracleSafetyBanner({ state }: { state: OracleState }) {
  if (!hasUnsafeOracleConfiguration(state)) return null;

  return (
    <section
      data-oracle-safety-warning
      role="alert"
      className="border-danger/40 bg-danger/10 rounded-sm border px-4 py-3"
    >
      <p className="text-muted text-sm">
        <strong className="text-danger">Unsafe devnet oracle configuration:</strong>{" "}
        {UNSAFE_ORACLE_MESSAGE}
      </p>
    </section>
  );
}

export function MagicBlockPricePanel({
  state,
  reload,
}: {
  state: MagicBlockPriceState;
  reload: () => Promise<void>;
}) {
  return (
    <section className="border-line bg-bg border-y p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="text-accent font-mono text-[0.8125rem] tracking-[0.08em] uppercase">
            Pyth Lazer · powered by MagicBlock
          </div>
          <h2 className="text-sm font-medium">Live market price</h2>
        </div>
        <button
          onClick={() => void reload()}
          className="text-dim hover:text-text text-xs underline-offset-2 hover:underline"
        >
          refresh
        </button>
      </header>

      {state.kind === "disabled" && (
        <p className="text-muted text-sm">No real-time price is configured for this asset.</p>
      )}
      {state.kind === "loading" && <p className="text-muted text-sm">reading MagicBlock…</p>}
      {state.kind === "error" && <p className="text-n text-sm">{state.message}</p>}
      {state.kind === "ready" && (
        <div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-dim">Price</dt>
            <dd className="font-mono tabular-nums">
              ${state.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
            </dd>
            <dt className="text-dim">Latest update</dt>
            <dd className="tabular-nums">
              {new Date(state.publishTime * 1000).toISOString().replace("T", " ").slice(0, 19)}
              {" · "}<span className="text-dim">{state.ageSecs}s ago</span>
            </dd>
            <dt className="text-dim">Execution layer</dt>
            <dd>MagicBlock ephemeral rollup</dd>
          </dl>
          <div className="border-line-soft mt-4 border-t pt-4">
            <AddressLink label="MagicBlock price account" address={state.address} />
          </div>
        </div>
      )}
    </section>
  );
}

export function OraclePanel({
  state,
  reload,
}: {
  state: OracleState;
  reload: () => Promise<void>;
}) {
  return (
    <section className="border-line bg-bg border-y p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="text-accent-ink font-mono text-[0.8125rem] tracking-[0.08em] uppercase">Pyth</div>
          <h2 className="text-sm font-medium">Settlement oracle</h2>
        </div>
        <button
          onClick={() => void reload()}
          className="text-dim hover:text-text text-xs underline-offset-2 hover:underline"
        >
          refresh
        </button>
      </header>

      {state.kind === "loading" && <p className="text-muted text-sm">reading…</p>}

      {state.kind === "undeployed" && (
        <p className="text-muted text-sm">
          The oracle adapter is not on this cluster.{" "}
          <code className="text-xs">{ORACLE_ADAPTER_PROGRAM.toBase58()}</code>
        </p>
      )}

      {state.kind === "unconfigured" && (
        <p className="text-muted text-sm">
          No price feed set up yet. Once one is, it can never be swapped for a different
          feed, only re-pointed at a fresh account for the same one.
        </p>
      )}

      {state.kind === "error" && (
        <p className="text-n text-sm">{state.message}</p>
      )}

      {state.kind === "ready" && (
        <div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-dim">Price</dt>
          <dd className="tabular-nums">
            {formatQuote(state.quote.price, state.quote.decimals)}{" "}
            <span className="text-dim">
              ({state.quote.decimals} dp, integer)
            </span>
          </dd>

          <dt className="text-dim">Confidence</dt>
          <dd className="tabular-nums">
            ±{formatQuote(state.quote.confidence, state.quote.decimals)}
          </dd>

          <dt className="text-dim">Latest update</dt>
          <dd className="tabular-nums">
            {new Date(state.quote.publishTime * 1000).toISOString().replace("T", " ").slice(0, 19)}
            {" · "}
            <span className={state.quote.stale ? "text-n" : "text-dim"}>
              {state.quote.ageSecs}s ago
              {state.quote.stale
                ? `, older than the ${state.config.maxAgeSecs}s limit, so settling would refuse it`
                : ""}
            </span>
          </dd>

          <dt className="text-dim">Verification</dt>
          <dd>
            {state.quote.verification.kind === "full"
              ? "Fully verified"
              : `${state.quote.verification.signatures} signatures`}
          </dd>

          <dt className="text-dim">Settlement status</dt>
          <dd className={state.quote.stale ? "text-danger" : "text-accent-ink"}>
            {state.quote.stale ? "Stale · settlement would reject this update" : "Fresh · within the configured settlement window"}
          </dd>

          <dt className="text-dim">Signature floor</dt>
          <dd className="tabular-nums">
            {state.config.minVerificationSignatures}
            {state.config.minVerificationSignatures === 0 && (
              <span className="text-n">
                {" "}
                (zero accepts a price with no signatures behind it)
              </span>
            )}
          </dd>

        </dl>
        <div className="border-line-soft mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2">
          <AddressLink label="Pyth source" address={state.config.source} />
          <AddressLink label="Oracle config" address={state.config.address} />
        </div>
        </div>
      )}
    </section>
  );
}
