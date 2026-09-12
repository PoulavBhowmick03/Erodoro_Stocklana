// SPDX-License-Identifier: Apache-2.0
//
// The §12 conservation invariants, checked against a live cluster.
//
// `docs/implementation.md` lists them and the test suites cover them on the
// host and in e2e. Neither says anything about the chain you actually deployed
// to. This reads every canonical series and asserts the same properties on real
// account state, so a breach is found by a cron job rather than by a user whose
// redemption came up short.
//
//   pnpm monitor [--url <rpc>] [--cluster devnet|mainnet]
//               [--snapshot <file>] [--webhook <url>]
//
// Exits non-zero if any invariant is violated. Intended for alerting: the exit
// code is the signal, the output is for whoever gets paged.
//
// What it deliberately does not do: fix anything, or take any action on chain.
// A monitor that can write is a monitor that can be turned into an attack.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

type Level = "ok" | "warn" | "breach";
const results: { level: Level; series: string; message: string }[] = [];
const record = (level: Level, series: string, message: string) =>
  results.push({ level, series, message });


/** Everything the invariants are computed from, and nothing else. */
export type SeriesState = {
  pSupply: bigint;
  nSupply: bigint;
  collateral: bigint;
  settlement: {
    atSettlement: bigint;
    pPool: bigint;
    nPool: bigint;
    pPaid: bigint;
    nPaid: bigint;
    shortfallObserved: boolean;
    supplyMismatch: boolean;
  } | null;
};

/**
 * The §12 conservation invariants, as a pure function.
 *
 * Pure on purpose. `programs/series/src/logic.rs` keeps its rules out of the
 * account plumbing so the invariants can be tested without a validator, and the
 * same reasoning applies to the thing that watches them: a monitor whose alarm
 * has never been seen to fire is indistinguishable from one that cannot. Run
 * `--self-test` to fire every one of them.
 */
export function checkSeries(s: SeriesState): { level: Level; message: string }[] {
  const out: { level: Level; message: string }[] = [];
  const say = (level: Level, message: string) => out.push({ level, message });

  if (!s.settlement) {
    // Invariant 1: the legs are minted and burned together, so their supplies
    // match outside settlement. A gap means a claim token was burned outside
    // the protocol -- tolerated by design, and the reason a series can settle
    // short.
    if (s.pSupply !== s.nSupply) {
      say(
        "warn",
        `p_supply ${s.pSupply} != n_supply ${s.nSupply} — a claim token was burned ` +
          `outside the protocol; this series will record supply_mismatch at settlement`,
      );
    } else {
      say("ok", `p_supply == n_supply (${s.pSupply})`);
    }

    // Invariant 2: the vault must cover what P can claim. A breach here is the
    // one that costs users money.
    if (s.collateral < s.pSupply) {
      say(
        "breach",
        `UNDER-COLLATERALIZED: vault holds ${s.collateral}, p_supply is ${s.pSupply} ` +
          `(short ${s.pSupply - s.collateral})`,
      );
    } else {
      say("ok", `vault ${s.collateral} >= p_supply ${s.pSupply}`);
    }
    return out;
  }

  const { atSettlement, pPool, nPool, pPaid, nPaid } = s.settlement;

  // Invariant 3: the split is exhaustive.
  if (pPool + nPool !== atSettlement) {
    say(
      "breach",
      `POOLS DO NOT SUM: p_pool ${pPool} + n_pool ${nPool} != ` +
        `collateral_at_settlement ${atSettlement}`,
    );
  } else {
    say("ok", `p_pool + n_pool == collateral_at_settlement (${atSettlement})`);
  }

  // Invariant 5: redemption never pays out more than was escrowed, in any order.
  if (pPaid + nPaid > atSettlement) {
    say("breach", `OVERPAID: ${pPaid + nPaid} paid against ${atSettlement} escrowed`);
  } else {
    say("ok", `paid ${pPaid + nPaid} <= escrowed ${atSettlement}`);
  }

  // And the vault must still hold whatever has not been redeemed.
  const owed = atSettlement - (pPaid + nPaid);
  if (s.collateral < owed) {
    say(
      "breach",
      `VAULT SHORT: holds ${s.collateral}, still owes ${owed} (short ${owed - s.collateral})`,
    );
  } else {
    say("ok", `vault ${s.collateral} covers the ${owed} still owed`);
  }

  // Flags the program set at settlement. Not breaches -- the protocol records
  // these rather than refusing to settle -- but a human has to know.
  if (s.settlement.shortfallObserved) {
    say(
      "warn",
      "shortfall_observed: the vault held less than it owed at settlement; " +
        "every redeemer takes the same haircut",
    );
  }
  if (s.settlement.supplyMismatch) {
    say("warn", "supply_mismatch recorded at settlement");
  }
  return out;
}


/** One market's books and the vaults that must cover them. */
export type MarketState = {
  /** Per leg: what the book's slots say traders hold in base. */
  baseHeld: { p: bigint; n: bigint };
  /** What the vault for each leg actually holds. */
  baseVault: { p: bigint; n: bigint };
  /** Quote is shared across both books, so it is summed and compared once. */
  quoteHeld: bigint;
  quoteVault: bigint;
  /** Legs whose book is currently delegated, and therefore stale on L1. */
  delegated: string[];
};

/**
 * The order book's conservation property: the vaults must cover what the
 * ledger says traders are owed.
 *
 * Nothing on chain enforces this. `deposit` credits a slot and moves tokens in
 * the same instruction and `withdraw` does the reverse, so they cannot diverge
 * through the happy path -- but that is an argument about the code, not an
 * observation about the chain, and `market`'s escrow ledger is the part
 * SECURITY.md says the internal review did not cover.
 *
 * `>=` rather than `==`: a vault holding more than the ledger claims is not a
 * breach. Anyone can transfer tokens into an account, and a surplus harms
 * nobody. A deficit is what costs a withdrawer their money.
 */
export function checkMarket(m: MarketState): { level: Level; message: string }[] {
  const out: { level: Level; message: string }[] = [];
  const say = (level: Level, message: string) => out.push({ level, message });

  for (const leg of ["p", "n"] as const) {
    const held = m.baseHeld[leg];
    const vault = m.baseVault[leg];
    if (vault < held) {
      say(
        "breach",
        `${leg.toUpperCase()} VAULT SHORT: ledger owes ${held}, vault holds ${vault} ` +
          `(short ${held - vault})`,
      );
    } else {
      say("ok", `${leg.toUpperCase()} vault ${vault} covers the ${held} owed`);
    }
  }

  if (m.quoteVault < m.quoteHeld) {
    say(
      "breach",
      `QUOTE VAULT SHORT: ledger owes ${m.quoteHeld}, vault holds ${m.quoteVault} ` +
        `(short ${m.quoteHeld - m.quoteVault})`,
    );
  } else {
    say("ok", `quote vault ${m.quoteVault} covers the ${m.quoteHeld} owed`);
  }

  // A delegated book lives in the rollup; the copy on L1 is whatever the last
  // commit left. Its balances are not wrong, they are behind, and comparing
  // them to a vault says nothing.
  if (m.delegated.length > 0) {
    say(
      "warn",
      `${m.delegated.join(" and ")} book delegated — the L1 ledger is as of the last ` +
        `commit, so the figures above are a lower bound`,
    );
  }
  return out;
}


/**
 * Post the findings somewhere a person will see them.
 *
 * The exit code is the real signal and a cron job can act on it alone, but an
 * exit code nobody is watching is a log file. `--webhook` takes any URL that
 * accepts a JSON POST -- Slack and Discord both do, as do PagerDuty's events
 * API and most on-call tools -- and sends a payload with both a `text` field
 * for the chat-shaped ones and the structured results for everything else.
 *
 * Failing to alert is itself reported and changes the exit code. A monitor that
 * silently could not reach its webhook is worse than one that never had a
 * webhook, because the silence reads as "nothing is wrong".
 */
export async function alert(
  url: string,
  cluster: string,
  results: { level: Level; series: string; message: string }[],
): Promise<boolean> {
  const breaches = results.filter((r) => r.level === "breach");
  const warns = results.filter((r) => r.level === "warn");
  if (breaches.length === 0 && warns.length === 0) return true;

  const headline =
    breaches.length > 0
      ? `INVARIANT BREACH on ${cluster}: the protocol owes more than it holds`
      : `${warns.length} warning(s) on ${cluster}`;

  const lines = [...breaches, ...warns].map((r) => `${r.series}  ${r.message}`);
  const body = {
    text: [headline, "", ...lines].join("\n"),
    cluster,
    breaches: breaches.length,
    warnings: warns.length,
    results: [...breaches, ...warns],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`alert POST failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("alert POST failed:", e instanceof Error ? e.message : e);
    return false;
  }
}


/**
 * The authorities and settings a compromised admin would change.
 *
 * Conservation invariants catch a vault that is already short. This catches the
 * step before: an admin key being used. Moving the *upgrade* authority to a
 * multisig does not touch these -- the factory admin still decides which
 * oracles may settle and which mints may be escrowed, the oracle admin can
 * still rotate a feed's source, and a series admin can still pause splits and
 * sweep dust once both supplies are zero.
 *
 * None of those is a breach on its own. Every one of them is a thing you want
 * to hear about within minutes rather than discover afterwards.
 */
export type Snapshot = Record<string, string>;

/** Compare two snapshots. Changed, added and removed are all reportable. */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
): { level: Level; series: string; message: string }[] {
  const out: { level: Level; series: string; message: string }[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    const [scope, ...rest] = k.split(":");
    const field = rest.join(":");
    if (!(k in before)) {
      out.push({ level: "warn", series: scope, message: `new: ${field} = ${after[k]}` });
    } else if (!(k in after)) {
      out.push({ level: "warn", series: scope, message: `gone: ${field} was ${before[k]}` });
    } else if (before[k] !== after[k]) {
      out.push({
        level: "warn",
        series: scope,
        message: `CHANGED: ${field} ${before[k]} -> ${after[k]}`,
      });
    }
  }
  return out;
}

/** Fire every alarm, so none of them is decorative. */
async function selfTest(): Promise<number> {
  const cases: [string, SeriesState, Level][] = [
    [
      "healthy, unsettled",
      { pSupply: 100n, nSupply: 100n, collateral: 100n, settlement: null },
      "ok",
    ],
    [
      "burned outside the protocol",
      { pSupply: 100n, nSupply: 99n, collateral: 100n, settlement: null },
      "warn",
    ],
    [
      "under-collateralized",
      { pSupply: 100n, nSupply: 100n, collateral: 99n, settlement: null },
      "breach",
    ],
    [
      "healthy, settled",
      {
        pSupply: 0n, nSupply: 0n, collateral: 40n,
        settlement: { atSettlement: 100n, pPool: 60n, nPool: 40n, pPaid: 60n, nPaid: 0n,
          shortfallObserved: false, supplyMismatch: false },
      },
      "ok",
    ],
    [
      "pools do not sum",
      {
        pSupply: 0n, nSupply: 0n, collateral: 100n,
        settlement: { atSettlement: 100n, pPool: 60n, nPool: 39n, pPaid: 0n, nPaid: 0n,
          shortfallObserved: false, supplyMismatch: false },
      },
      "breach",
    ],
    [
      "overpaid",
      {
        pSupply: 0n, nSupply: 0n, collateral: 0n,
        settlement: { atSettlement: 100n, pPool: 60n, nPool: 40n, pPaid: 60n, nPaid: 41n,
          shortfallObserved: false, supplyMismatch: false },
      },
      "breach",
    ],
    [
      "vault short of what it still owes",
      {
        pSupply: 0n, nSupply: 0n, collateral: 10n,
        settlement: { atSettlement: 100n, pPool: 60n, nPool: 40n, pPaid: 50n, nPaid: 0n,
          shortfallObserved: false, supplyMismatch: false },
      },
      "breach",
    ],
  ];

  const marketCases: [string, MarketState, Level][] = [
    [
      "market solvent",
      { baseHeld: { p: 10n, n: 20n }, baseVault: { p: 10n, n: 20n },
        quoteHeld: 30n, quoteVault: 30n, delegated: [] },
      "ok",
    ],
    [
      "market vault surplus is not a breach",
      { baseHeld: { p: 10n, n: 20n }, baseVault: { p: 11n, n: 21n },
        quoteHeld: 30n, quoteVault: 31n, delegated: [] },
      "ok",
    ],
    [
      "base vault short",
      { baseHeld: { p: 10n, n: 20n }, baseVault: { p: 9n, n: 20n },
        quoteHeld: 30n, quoteVault: 30n, delegated: [] },
      "breach",
    ],
    [
      "quote vault short",
      { baseHeld: { p: 10n, n: 20n }, baseVault: { p: 10n, n: 20n },
        quoteHeld: 30n, quoteVault: 29n, delegated: [] },
      "breach",
    ],
    [
      "delegated book is a warning, not a breach",
      { baseHeld: { p: 0n, n: 0n }, baseVault: { p: 0n, n: 0n },
        quoteHeld: 0n, quoteVault: 0n, delegated: ["N"] },
      "warn",
    ],
  ];

  let bad = 0;

  const snapCases: [string, Snapshot, Snapshot, number][] = [
    ["unchanged", { "a:admin": "X" }, { "a:admin": "X" }, 0],
    ["rotated admin", { "a:admin": "X" }, { "a:admin": "Y" }, 1],
    ["new entry", {}, { "a:admin": "X" }, 1],
    ["removed entry", { "a:admin": "X" }, {}, 1],
  ];
  for (const [name, before, after, expected] of snapCases) {
    const n = diffSnapshots(before, after).length;
    if (n === expected) {
      console.log(`  ok   snapshot diff: ${name}`);
    } else {
      bad++;
      console.log(`  FAIL snapshot diff: ${name} -> ${n} findings, expected ${expected}`);
    }
  }

  // The delivery path, not just the alarms. A monitor that could not reach its
  // webhook and said nothing reads as "all clear", which is the worst possible
  // failure for this tool.
  const unreachable = await alert("http://127.0.0.1:9/nothing-listens-here", "self-test", [
    { level: "breach", series: "test", message: "synthetic" },
  ]);
  if (unreachable === false) {
    console.log("  ok   an unreachable webhook reports failure");
  } else {
    bad++;
    console.log("  FAIL an unreachable webhook was treated as delivered");
  }
  const nothingToSay = await alert("http://127.0.0.1:9/nothing-listens-here", "self-test", [
    { level: "ok", series: "test", message: "healthy" },
  ]);
  if (nothingToSay === true) {
    console.log("  ok   a clean run posts nothing and does not fail");
  } else {
    bad++;
    console.log("  FAIL a clean run tried to post");
  }

  for (const [name, state, expected] of marketCases) {
    const levels = checkMarket(state).map((r) => r.level);
    const worst: Level = levels.includes("breach")
      ? "breach"
      : levels.includes("warn")
        ? "warn"
        : "ok";
    if (worst === expected) {
      console.log(`  ok   ${name} -> ${worst}`);
    } else {
      bad++;
      console.log(`  FAIL ${name} -> ${worst}, expected ${expected}`);
    }
  }

  for (const [name, state, expected] of cases) {
    const levels = checkSeries(state).map((r) => r.level);
    const worst: Level = levels.includes("breach")
      ? "breach"
      : levels.includes("warn")
        ? "warn"
        : "ok";
    if (worst === expected) {
      console.log(`  ok   ${name} -> ${worst}`);
    } else {
      bad++;
      console.log(`  FAIL ${name} -> ${worst}, expected ${expected}`);
    }
  }
  console.log(bad === 0 ? "\nevery alarm fires\n" : `\n${bad} alarms did not behave\n`);
  return bad;
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

const root = path.resolve(import.meta.dirname, "..");
const idl = (n: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "web", "lib", "idl", `${n}.json`), "utf8"));

/** `getMultipleAccounts` caps at 100 keys. */
async function batched(conn: Connection, keys: PublicKey[]) {
  const out: (anchor.web3.AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  }
  return out;
}

async function main() {
  const a = args();
  if ("self-test" in a) {
    process.exit((await selfTest()) === 0 ? 0 : 1);
  }
  const cluster = a.cluster ?? "devnet";
  const url =
    a.url ??
    (cluster === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com");

  const conn = new Connection(url, "confirmed");
  const factoryIdl = idl("factory");
  const seriesIdl = idl("series");

  console.log(`\nmonitor · ${cluster} · ${url}\n`);

  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(anchor.web3.Keypair.generate()),
    { commitment: "confirmed" },
  );
  const factory = new anchor.Program(factoryIdl, provider);
  const series = new anchor.Program(seriesIdl, provider);
  const oracle = new anchor.Program(idl("oracle_adapter"), provider);
  // Kept so the authority snapshot below can see them without re-fetching.
  const seriesViews: { address: PublicKey; config: any }[] = [];

  const records = (await (factory.account as any).seriesRecord.all()) as {
    account: { series: PublicKey };
  }[];
  if (records.length === 0) {
    console.log("no canonical series on this cluster — nothing to check\n");
    return;
  }
  console.log(`${records.length} canonical series\n`);

  const settlementPda = (s: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("settlement"), s.toBuffer()], series.programId)[0];

  const keys: PublicKey[] = [];
  for (const r of records) keys.push(r.account.series, settlementPda(r.account.series));
  const infos = await batched(conn, keys);

  for (let i = 0; i < records.length; i++) {
    const address = records[i].account.series;
    const tag = address.toBase58().slice(0, 8);
    const configInfo = infos[i * 2];
    const settlementInfo = infos[i * 2 + 1];
    if (!configInfo) {
      record("warn", tag, "registered, but the series account is gone");
      continue;
    }

    const config = series.coder.accounts.decode("seriesConfig", configInfo.data) as any;
    seriesViews.push({ address, config });
    const settlement = settlementInfo
      ? (series.coder.accounts.decode("settlement", settlementInfo.data) as any)
      : null;

    // P and N are plain SPL mints; the collateral is Token-2022.
    const [pMint, nMint, vault] = await Promise.all([
      getMint(conn, config.pMint, "confirmed", TOKEN_PROGRAM_ID),
      getMint(conn, config.nMint, "confirmed", TOKEN_PROGRAM_ID),
      getAccount(conn, config.collateralVault, "confirmed", TOKEN_2022_PROGRAM_ID),
    ]);

    const pSupply = pMint.supply;
    const nSupply = nMint.supply;
    const collateral = vault.amount;

    for (const r of checkSeries({
      pSupply,
      nSupply,
      collateral,
      settlement: settlement
        ? {
            atSettlement: BigInt(settlement.collateralAtSettlement.toString()),
            pPool: BigInt(settlement.pPool.toString()),
            nPool: BigInt(settlement.nPool.toString()),
            pPaid: BigInt(settlement.pPaid.toString()),
            nPaid: BigInt(settlement.nPaid.toString()),
            shortfallObserved: Boolean(settlement.shortfallObserved),
            supplyMismatch: Boolean(settlement.supplyMismatch),
          }
        : null,
    })) {
      record(r.level, tag, r.message);
    }
  }

  // --- the order book's ledger ------------------------------------------
  //
  // `market` holds real deposits in three vaults per market, and SECURITY.md
  // says outright that the internal review covered the series and oracle
  // lifecycle and must not be read as an audit of this ledger. So it is watched
  // rather than assumed.
  const marketIdl = idl("market");
  const market = new anchor.Program(marketIdl, provider);
  const markets = (await (market.account as any).market.all()) as {
    publicKey: PublicKey;
    account: any;
  }[];

  if (markets.length === 0) {
    console.log("no markets on this cluster\n");
  } else {
    console.log(`${markets.length} markets\n`);
  }

  const legTag = (leg: any) => (leg && "p" in leg ? "p" : "n");

  for (const m of markets) {
    const tag = m.publicKey.toBase58().slice(0, 8);
    const held = { p: 0n, n: 0n };
    const delegated: string[] = [];
    let quoteHeld = 0n;

    for (const leg of ["p", "n"] as const) {
      const [bookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("book"), m.publicKey.toBuffer(), Buffer.from([leg === "p" ? 0 : 1])],
        market.programId,
      );
      const info = await conn.getAccountInfo(bookPda);
      if (!info) continue; // That leg's book was never opened.

      // While a book is delegated the delegation program owns it, which is the
      // property that stops `deposit` and `withdraw` running against a ledger
      // the rollup is still mutating. Decoding it is fine; trusting it as
      // current is not.
      if (!info.owner.equals(market.programId)) {
        delegated.push(leg.toUpperCase());
      }

      let book: any;
      try {
        book = market.coder.accounts.decode("book", info.data);
      } catch {
        record("warn", tag, `${leg.toUpperCase()} book could not be decoded`);
        continue;
      }
      if (legTag(book.leg) !== leg) {
        record("warn", tag, `${leg.toUpperCase()} book records leg ${legTag(book.leg)}`);
      }
      for (const slot of book.slots) {
        if (!slot.occupied) continue;
        held[leg] +=
          BigInt(slot.baseFree.toString()) + BigInt(slot.baseLocked.toString());
        quoteHeld +=
          BigInt(slot.quoteFree.toString()) + BigInt(slot.quoteLocked.toString());
      }
    }

    const vaultAmount = async (k: PublicKey) => {
      const acc = await conn.getAccountInfo(k);
      if (!acc) return 0n;
      // Token account layout: mint(32) owner(32) amount(u64).
      return acc.data.readBigUInt64LE(64);
    };
    const [pVault, nVault, quoteVault] = await Promise.all([
      vaultAmount(m.account.pVault),
      vaultAmount(m.account.nVault),
      vaultAmount(m.account.quoteVault),
    ]);

    for (const r of checkMarket({
      baseHeld: held,
      baseVault: { p: pVault, n: nVault },
      quoteHeld,
      quoteVault,
      delegated,
    })) {
      record(r.level, tag, r.message);
    }
  }

  // --- authority drift ---------------------------------------------------
  //
  // `--snapshot <file>` records the keys and settings an admin could change and
  // compares against the last run. First run writes the baseline and reports
  // nothing; every run after reports what moved.
  const snapshotPath = a.snapshot || "";
  if (snapshotPath) {
    const snap: Snapshot = {};

    // Program upgrade authorities. The one preflight gates on, watched between
    // deploys rather than only before one.
    for (const [name, id] of Object.entries(
      JSON.parse(
        fs.readFileSync(path.resolve(import.meta.dirname, "..", "deployments", `${cluster}.json`), "utf8"),
      ).programs as Record<string, string>,
    )) {
      const info = await conn.getAccountInfo(new PublicKey(id));
      if (!info) continue;
      // Program account: 4-byte enum then the programdata address.
      const pd = await conn.getAccountInfo(new PublicKey(info.data.subarray(4, 36)));
      if (!pd) continue;
      snap[`${name}:upgrade-authority`] =
        pd.data.readUInt8(12) === 1
          ? new PublicKey(pd.data.subarray(13, 45)).toBase58()
          : "revoked";
    }

    // Series admins and status: a pause, or an admin rotation.
    for (const view of seriesViews) {
      const tag = view.address.toBase58().slice(0, 8);
      snap[`${tag}:series-admin`] = view.config.admin.toBase58();
      snap[`${tag}:status`] = Object.keys(view.config.status)[0];
      // The feed the series settles against, and who may rotate it.
      const feed = await (oracle.account as any).feedConfig
        .fetchNullable(view.config.oracleAdapter)
        .catch(() => null);
      if (feed) {
        snap[`${tag}:oracle-admin`] = feed.admin.toBase58();
        snap[`${tag}:oracle-source`] = feed.source.toBase58();
        snap[`${tag}:oracle-min-sigs`] = String(feed.minVerificationSignatures);
      }
    }

    const previous: Snapshot | null = fs.existsSync(snapshotPath)
      ? JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
      : null;
    if (previous === null) {
      console.log(`baseline written to ${snapshotPath} (${Object.keys(snap).length} entries)\n`);
    } else {
      for (const d of diffSnapshots(previous, snap)) {
        record(d.level, d.series, d.message);
      }
    }
    fs.writeFileSync(snapshotPath, JSON.stringify(snap, null, 2) + "\n");
  }

  // --- report -------------------------------------------------------------
  console.log("");
  for (const r of results) {
    const tag =
      r.level === "ok" ? "  ok   " : r.level === "warn" ? " warn  " : " BREACH";
    console.log(`[${tag}] ${r.series}  ${r.message}`);
  }
  const breaches = results.filter((r) => r.level === "breach").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\n${results.length} checks: ${breaches} breaches, ${warns} warnings\n`);

  // `--webhook <url>`, or `MONITOR_WEBHOOK` in the environment so the URL does
  // not end up in a crontab or a process list.
  const webhook = a.webhook || process.env.MONITOR_WEBHOOK || "";
  let alerted = true;
  if (webhook) {
    alerted = await alert(webhook, cluster, results);
  } else if (breaches > 0) {
    console.error("no --webhook configured; this breach was reported nowhere but here");
  }

  if (breaches > 0) {
    console.error("INVARIANT BREACH — the protocol owes more than it holds\n");
    process.exit(1);
  }
  if (!alerted) {
    // Nothing is wrong on chain, but the thing that would have told you is
    // broken. That is worth a distinct code so a cron job can tell them apart.
    console.error("warnings could not be delivered to the webhook\n");
    process.exit(3);
  }
}

main().catch((e) => {
  // A monitor that dies quietly is worse than no monitor: page on it.
  console.error("monitor failed to complete:", e);
  process.exit(2);
});
