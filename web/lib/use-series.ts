"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { usePrograms } from "./programs";
import { settlementPda } from "./pdas";
import { getMultipleAccountsBatched, withRetry } from "./batch";
import type { SeriesConfig, SeriesRecord, SeriesView, Settlement } from "./series-types";

export type { SeriesView } from "./series-types";

/**
 * The names `program.coder.accounts.decode` answers to.
 *
 * **camelCase**, matching `program.account.*` -- even though the IDL itself
 * spells them `SeriesConfig` and `Settlement`. `Program`'s constructor
 * normalises account names on the way in; a `BorshAccountsCoder` built directly
 * from the same IDL does not, and answers to the PascalCase form instead. The
 * two disagree, and only one of them is what this file holds.
 *
 * Getting it wrong throws on every decode, and because a decode failure is
 * deliberately tolerated below -- one malformed account must not blank the
 * whole list -- the symptom is an empty markets table rather than an error.
 * `scripts/check-accounts.mjs` asserts these resolve.
 */
const ACCOUNT = { config: "seriesConfig", settlement: "settlement" } as const;

type State =
  | { kind: "loading" }
  | { kind: "undeployed" }
  | { kind: "ready"; series: SeriesView[] }
  | { kind: "error"; message: string };

/**
 * Every canonical series, read from the factory's registry.
 *
 * Deliberately *not* `series.account.seriesConfig.all()`. Creation is
 * permissionless — anyone can open a series naming themselves as admin — so
 * listing the series program's accounts at large would surface hostile ones
 * beside real ones. The registry is what makes a series canonical, and it is
 * the only thing a front end should trust.
 *
 * # Round trips
 *
 * One `getProgramAccounts` for the registry, then the configs and settlements
 * in batches of 100 through `getMultipleAccounts` — `1 + ceil(2N / 100)`
 * requests to list N series.
 *
 * The obvious shape, `fetch` per account, is `1 + 2N`: three requests for the
 * three series on devnet and two hundred for a hundred series. Public endpoints
 * answer that with 429, and the page shows an error to a user whose only
 * mistake was arriving when the protocol had become popular.
 */
export function useSeries() {
  const { factory, series: seriesProgram } = usePrograms();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async (showLoading = true) => {
    // Initial navigation needs a skeleton. A post-transaction refresh does
    // not: replacing the ready market with the route skeleton unmounts the
    // transaction status, making a confirmed action look like a page reload.
    if (showLoading) setState({ kind: "loading" });
    try {
      const conn = factory.provider.connection;

      // Distinguish "no series yet" from "the programs aren't on this
      // cluster" — they look identical through an empty account list, and
      // only one of them is the user's problem.
      const [factoryInfo, seriesInfo] = await withRetry(() =>
        conn.getMultipleAccountsInfo([factory.programId, seriesProgram.programId]),
      );
      if (!factoryInfo?.executable || !seriesInfo?.executable) {
        setState({ kind: "undeployed" });
        return;
      }

      const records = (await withRetry(() =>
        (factory.account as any).seriesRecord.all(),
      )) as { account: SeriesRecord }[];

      if (records.length === 0) {
        setState({ kind: "ready", series: [] });
        return;
      }

      // Configs and settlements in one pass. Interleaving them keeps the index
      // arithmetic to a single `* 2`, and both accounts for a series land in
      // the same chunk.
      const keys: PublicKey[] = [];
      for (const r of records) {
        keys.push(r.account.series, settlementPda(r.account.series));
      }
      const infos = await getMultipleAccountsBatched(conn, keys);

      const coder = seriesProgram.coder.accounts;
      const series: SeriesView[] = [];
      for (let i = 0; i < records.length; i++) {
        const configInfo = infos[i * 2];
        const settlementInfo = infos[i * 2 + 1];
        if (!configInfo) continue; // Registered, but the account is gone.

        // A single malformed account must not blank the whole list.
        let config: SeriesConfig;
        try {
          config = coder.decode<SeriesConfig>(ACCOUNT.config, configInfo.data);
        } catch {
          continue;
        }

        let settlement: Settlement | null = null;
        if (settlementInfo) {
          try {
            settlement = coder.decode<Settlement>(ACCOUNT.settlement, settlementInfo.data);
          } catch {
            // Not settled, or written by a version this build cannot read.
            settlement = null;
          }
        }

        series.push({
          address: records[i].account.series,
          config,
          settlement,
          record: records[i].account,
        });
      }

      series.sort(
        (a, b) => a.config.maturityTs.toNumber() - b.config.maturityTs.toNumber(),
      );
      setState({ kind: "ready", series });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [factory, seriesProgram]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const reload = useCallback(() => load(false), [load]);
  return { state, reload };
}
