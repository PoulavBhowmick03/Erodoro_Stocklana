"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { useConnection } from "@solana/wallet-adapter-react";

import { usePrograms } from "@/lib/programs";
import { useSend } from "@/lib/use-send";
import { useSigner } from "@/lib/use-signer";
import {
  approveCollateralIx,
  approveOracleIx,
  createSeriesIx,
  initFactoryIx,
  initFeedConfigIx,
  rollupValidator,
} from "@/lib/actions";
import {
  approvedCollateralPda,
  approvedOraclePda,
  factoryPda,
  feedConfigPda,
  nMintPda,
  pMintPda,
  seriesPda,
} from "@/lib/pdas";
import { LAST_MINT_KEY, LAST_SERIES_KEY } from "@/lib/use-token-balances";
import { QUOTE_MINT } from "@/lib/deployment";
import {
  MAGICBLOCK_DELEGATION_PROGRAM_ID,
  MANIFEST_PROGRAM_ID,
  createManifestMarketIxs,
  delegateManifestMarketIx,
  manifestMarketPda,
  prepareManifestMarketCustodyIxs,
} from "@/lib/manifest";
import {
  manifestBookReadiness,
  waitForManifestBookLive,
} from "@/lib/manifest-readiness";
import { useEphemeral } from "@/lib/rollup";
import { ADMIN_ROLE, TEST_ADDRESSES, type TestRole } from "@/lib/test-wallets";
import { AmountInput, Button, Panel, TextInput, TxStatus } from "./ui";
import { useTestWallet } from "./test-wallet";
import { DevnetSetupProgress } from "./devnet-setup-progress";
import { DEVNET_MARKET_PROFILE, feedIdBytes } from "@/lib/market-profile";

const SOL_USD_FEED_ID = feedIdBytes(DEVNET_MARKET_PROFILE.settlementFeedIdHex);
const DEVNET_PYTH_SOL_USD = new PublicKey(DEVNET_MARKET_PROFILE.settlementSource);
// This PDA is fixed for the lifetime of the page. Keeping it outside the
// component is important: a fresh PublicKey in `refresh`'s dependency list on
// every render turns refresh -> setState -> render into an RPC request loop.
const DEVNET_FEED_CONFIG = feedConfigPda(SOL_USD_FEED_ID);

type Done = { factory: boolean; feed: boolean; oracle: boolean; collateral: boolean };
type Action = "factory" | "feed" | "oracle" | "listing";
type ListingPhase = "allowlisting" | "creating" | "activating" | null;

/**
 * Bring a listed and tradable series into existence as one administrator task.
 *
 * The order is forced by the program, not chosen: the factory must exist before
 * it can approve anything, a feed config must exist before it can be approved,
 * and `create_series` takes both approval PDAs as accounts — their existence
 * *is* the permission. The UI groups the mint approval and series creation,
 * while retaining every transaction boundary so a partial run can resume.
 */
export function CreatePanel() {
  const { connection } = useConnection();
  const { connection: rollup } = useEphemeral();
  const publicKey = useSigner();
  const { factory, oracle, series: seriesProgram } = usePrograms();
  const { state, send, reset } = useSend();
  const { role: testRole, setRole: setTestRole, enabled: testWalletsEnabled } = useTestWallet();

  const [mint, setMint] = useState("");
  const [autofilled, setAutofilled] = useState(false);
  /**
   * Once the field has been touched it is the user's, and nothing refills it.
   * Clearing it counts as touching it: a field that grew its contents back
   * after being emptied would be worse than one that never filled itself.
   */
  const touched = useRef(false);
  const [strike, setStrike] = useState("150");
  const [days, setDays] = useState("30");
  const [done, setDone] = useState<Done>({
    factory: false,
    feed: false,
    oracle: false,
    collateral: false,
  });
  const [factoryAdmin, setFactoryAdmin] = useState<PublicKey | null>(null);
  const [activeAction, setActiveAction] = useState<Action | null>(null);
  const [listingPhase, setListingPhase] = useState<ListingPhase>(null);
  const [listedSeries, setListedSeries] = useState<string | null>(null);
  const [listedMarketLive, setListedMarketLive] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);
  const [setupAssets, setSetupAssets] = useState({ stock: false, cash: false });

  const feedConfig = DEVNET_FEED_CONFIG;
  let mintKey: PublicKey | null = null;
  try {
    mintKey = mint ? new PublicKey(mint) : null;
  } catch {
    mintKey = null;
  }

  const refresh = useCallback(async () => {
    const [f, fc, oa, ca] = await Promise.all([
      connection.getAccountInfo(factoryPda()),
      connection.getAccountInfo(feedConfig),
      connection.getAccountInfo(approvedOraclePda(feedConfig)),
      mintKey
        ? connection.getAccountInfo(approvedCollateralPda(mintKey))
        : Promise.resolve(null),
    ]);

    const nextAdmin = f
      ? ((factory.coder.accounts.decode("factoryState", f.data) as any).admin as PublicKey)
      : null;
    setFactoryAdmin((current) =>
      (current && nextAdmin && current.equals(nextAdmin)) || (!current && !nextAdmin)
        ? current
        : nextAdmin,
    );

    const next: Done = {
      factory: Boolean(f),
      feed: Boolean(fc),
      oracle: Boolean(oa),
      collateral: Boolean(ca),
    };
    setDone((current) =>
      current.factory === next.factory &&
      current.feed === next.feed &&
      current.oracle === next.oracle &&
      current.collateral === next.collateral
        ? current
        : next,
    );
  }, [connection, factory, mint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The stock token is created by the seller on /mint, then allowlisted by a
  // different signer here. Token ownership is therefore the wrong handoff:
  // the registry admin neither holds nor needs to hold the collateral. Carry
  // the exact mint the browser just created instead, while leaving a field the
  // user has touched entirely alone.
  useEffect(() => {
    if (touched.current) return;
    const last = window.sessionStorage.getItem(LAST_MINT_KEY);
    if (!last) return;
    setMint((current) => {
      if (current || touched.current) return current;
      setAutofilled(true);
      return last;
    });
  }, []);

  useEffect(() => {
    setSetupAssets({
      stock: Boolean(window.sessionStorage.getItem(LAST_MINT_KEY)),
      cash: true,
    });
    setListedSeries(window.sessionStorage.getItem(LAST_SERIES_KEY));
  }, []);

  const tradingIsLive = useCallback(
    async (address: PublicKey) => {
      for (const baseMint of [pMintPda(address), nMintPda(address)]) {
        const readiness = await manifestBookReadiness({
          l1: connection,
          rollup,
          market: manifestMarketPda(baseMint, QUOTE_MINT, MANIFEST_PROGRAM_ID),
          programId: MANIFEST_PROGRAM_ID,
        });
        if (readiness.kind !== "live") return false;
      }
      return true;
    },
    [connection, rollup],
  );

  // A refresh must recover from chain state, not turn a saved series address
  // into a success message. LAST_SERIES_KEY is only a pointer to the work; the
  // two delegated books decide whether that work is actually complete.
  useEffect(() => {
    if (!listedSeries) {
      setListedMarketLive(false);
      return;
    }
    let current = true;
    void tradingIsLive(new PublicKey(listedSeries))
      .then((live) => {
        if (current) setListedMarketLive(live);
      })
      .catch(() => {
        if (current) setListedMarketLive(false);
      });
    return () => {
      current = false;
    };
  }, [listedSeries, tradingIsLive]);

  const run = async (action: Action, build: () => Promise<any>) => {
    setActiveAction(action);
    await send(build);
    await refresh();
  };

  const editMint = (v: string) => {
    touched.current = true;
    setAutofilled(false);
    setListedSeries(null);
    setListedMarketLive(false);
    setListingError(null);
    window.sessionStorage.removeItem(LAST_SERIES_KEY);
    setMint(v.trim());
    reset();
  };

  const busy = state.kind === "sending" || listingPhase !== null;
  const ctx = { factory, wallet: publicKey! };
  const isFactoryAdmin = Boolean(publicKey && factoryAdmin?.equals(publicKey));
  const adminTestRole = factoryAdmin
    ? ((Object.keys(TEST_ADDRESSES) as TestRole[]).find(
        (role) => TEST_ADDRESSES[role] === factoryAdmin.toBase58(),
      ) ?? null)
    : null;
  const needsAdmin = done.factory && Boolean(factoryAdmin) && !isFactoryAdmin;
  const switchToAdmin =
    testWalletsEnabled && adminTestRole
      ? () => {
          setTestRole(adminTestRole);
          setActiveAction(null);
          reset();
        }
      : undefined;
  const adminNotice = needsAdmin ? (
    <AdminNotice
      admin={factoryAdmin!}
      testRole={testRole}
      adminTestRole={adminTestRole}
      onSwitch={switchToAdmin}
    />
  ) : null;

  const maturityTs = new BN(
    Math.floor(Date.now() / 1000) + Math.max(1, Number(days || "0")) * 86_400,
  );
  // The strike must use the same scale as the approved settlement feed.
  const priceDecimals = Math.abs(DEVNET_MARKET_PROFILE.settlementExponent);
  const strikeRaw = new BN(Math.round(Number(strike || "0") * 10 ** priceDecimals));

  const seriesAddress =
    mintKey && strikeRaw.gtn(0)
      ? seriesPda(factoryPda(), mintKey, strikeRaw, maturityTs)
      : null;

  const setupDone = done.factory && done.feed && done.oracle;

  const activateTrading = async (address: PublicKey, maturityTimestamp: bigint) => {
    const validator = await rollupValidator();
    for (const baseMint of [pMintPda(address), nMintPda(address)]) {
      const created = createManifestMarketIxs({
        payer: publicKey!,
        baseMint,
        quoteMint: QUOTE_MINT,
        maturityTimestamp,
        programId: MANIFEST_PROGRAM_ID,
      });
      const existing = await connection.getAccountInfo(created.market, "confirmed");
      if (!existing) {
        const opened = await send(async () => created.ixs);
        if (!opened) return false;
      } else if (!existing.owner.equals(MANIFEST_PROGRAM_ID)) {
        if (!existing.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM_ID)) {
          throw new Error(
            `Order book ${created.market.toBase58()} has an unexpected owner.`,
          );
        }
        await waitForManifestBookLive({
          l1: connection,
          rollup,
          market: created.market,
          programId: MANIFEST_PROGRAM_ID,
        });
        continue;
      }

      // Keep each mint's custody preparation in its own transaction. The
      // proven bootstrap script does the same: combining both sets can exceed
      // the legacy transaction account/size budget and strand a listed series.
      for (const mint of [baseMint, QUOTE_MINT]) {
        const custodyIxs = await prepareManifestMarketCustodyIxs({
          connection,
          payer: publicKey!,
          market: created.market,
          mints: [mint],
          validator,
        });
        if (custodyIxs.length) {
          const prepared = await send(async () => custodyIxs);
          if (!prepared) return false;
        }
      }
      const delegated = await send(async () => [
        await delegateManifestMarketIx({
          payer: publicKey!,
          market: created.market,
          validator,
          programId: MANIFEST_PROGRAM_ID,
        }),
      ]);
      if (!delegated) return false;
      await waitForManifestBookLive({
        l1: connection,
        rollup,
        market: created.market,
        programId: MANIFEST_PROGRAM_ID,
      });
    }
    return true;
  };

  /**
   * One administrator action, even though the chain needs several transactions.
   *
   * The approval PDA must exist before `create_series` runs, and the Manifest
   * books must exist before custody and delegation. Each confirmed boundary is
   * recoverable: retry reads the saved series and resumes at the first missing
   * on-chain account instead of repeating completed work.
   */
  const listContract = async () => {
    if (!mintKey || !isFactoryAdmin || !setupDone) return;
    setActiveAction("listing");
    setListingError(null);
    setListedMarketLive(false);
    reset();

    try {
      if (!done.collateral) {
        setListingPhase("allowlisting");
        const approved = await send(() => approveCollateralIx(ctx, mintKey!));
        if (!approved) return;
      }

      let address: PublicKey;
      let marketMaturity: bigint;

      if (listedSeries) {
        // A prior click may have created the series before a later custody or
        // delegation transaction failed. Resume that exact series; deriving a
        // new PDA from Date.now() would silently create another expiry.
        address = new PublicKey(listedSeries);
        const config = (await (seriesProgram.account as any).seriesConfig.fetch(address)) as {
          collateralMint: PublicKey;
          maturityTs: BN;
        };
        if (!config.collateralMint.equals(mintKey)) {
          throw new Error("The saved market belongs to a different collateral mint.");
        }
        marketMaturity = BigInt(config.maturityTs.toString());
      } else {
        setListingPhase("creating");
        const created = await send(() =>
          createSeriesIx(
            ctx,
            seriesProgram.programId,
            mintKey!,
            TOKEN_2022_PROGRAM_ID,
            feedConfig,
            {
              strike: strikeRaw,
              maturityTs,
              priceDecimals,
              settlementDelaySecs: new BN(0),
              maxOracleAgeSecs: new BN(86_400),
              maxPriceLagSecs: new BN(86_400),
              minSplitAmount: new BN(1),
              feeBps: 0,
            },
          ),
        );
        if (!created || !seriesAddress) return;
        address = seriesAddress;
        marketMaturity = BigInt(maturityTs.toString());
        const saved = address.toBase58();
        window.sessionStorage.setItem(LAST_SERIES_KEY, saved);
        setListedSeries(saved);
      }

      setListingPhase("activating");
      const activated = await activateTrading(address, marketMaturity);
      if (!activated) return;
      if (!(await tradingIsLive(address))) {
        throw new Error("Both order books were submitted but are not live on MagicBlock.");
      }
      setListedMarketLive(true);
      await refresh();
    } catch (error) {
      setListingError(error instanceof Error ? error.message : String(error));
    } finally {
      setListingPhase(null);
    }
  };

  // Whether to show the registry at all. A test key names the person it stands
  // for, so `admin` is the role that administers and the two traders are not --
  // showing them a form only the admin can submit was the whole confusion. A
  // real wallet is judged on whether it actually holds the authority.
  const showAdmin = testRole ? testRole === ADMIN_ROLE : isFactoryAdmin;

  return (
    <div className="space-y-4">
      <DevnetSetupProgress
        current={listedSeries ? 3 : 2}
        completed={[
          setupAssets.stock,
          setupAssets.cash,
          Boolean(listedSeries),
          false,
        ]}
      />

      <section className="border-line bg-panel rounded-md border p-5" aria-label="Registry status">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow">Administrative workspace</div>
            <h2 className="mt-2 text-2xl font-medium tracking-[-0.035em]">Approve once. List markets cleanly.</h2>
            <p className="text-muted mt-2 max-w-2xl text-sm leading-6">Network configuration stays separate from the market terms traders will see.</p>
          </div>
          <span className={`rounded-sm border px-2.5 py-1 font-mono text-[0.8125rem] tracking-[0.08em] uppercase ${setupDone ? "border-p/30 bg-p/5 text-p" : "border-n/30 bg-n/5 text-n"}`}>
            {setupDone ? "Network ready" : "Setup required"}
          </span>
        </div>
        <dl className="border-line-soft mt-5 grid border-t pt-4 sm:grid-cols-3 sm:divide-x sm:divide-[var(--color-line-soft)]">
          {[
            ["Authority", factoryAdmin ? `${factoryAdmin.toBase58().slice(0, 6)}…${factoryAdmin.toBase58().slice(-4)}` : "Not initialized"],
            ["Price feed", done.oracle ? "Approved" : "Pending"],
            ["Collateral", done.collateral ? "Approved" : mintKey ? "Ready to approve" : "Choose a mint"],
          ].map(([label, value]) => (
            <div key={label} className="py-2 sm:px-4 sm:first:pl-0">
              <dt className="text-dim font-mono text-[0.8125rem] tracking-[0.1em] uppercase">{label}</dt>
              <dd className="mt-1 text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {listedSeries && listedMarketLive && (
        <section className="border-p/30 bg-p/5 rounded-md border p-5">
          <div className="text-p font-mono text-[0.8125rem] tracking-[0.12em] uppercase">
            Market listed
          </div>
          <p className="text-muted mt-1 text-sm">The admin step is complete.</p>
          <Link
            href={`/trade/markets?market=${listedSeries}&view=n`}
            className="bg-text hover:bg-accent text-bg mt-4 inline-flex items-center gap-4 rounded-sm px-4 py-2 text-sm font-medium transition-colors"
          >
            Open market →
          </Link>
        </section>
      )}

      {!showAdmin && (
        <Panel
          tour="registry-note"
          title="Listing is an admin action"
          subtitle="You are signing as a trader, so the registry steps are not shown."
        >
          <p className="text-muted max-w-[68ch] text-[0.9rem]">
            Anyone can create a series and it will work. Being <em>listed</em> cannot:{" "}
            <code className="text-dim">create_series</code> takes the factory admin as a
            signer. Pick the <span className="text-accent-ink">admin</span> key above to see
            those steps.
          </p>
        </Panel>
      )}

      {/* Steps 01-03 and the registry explainer are once-per-network admin
          work: on any cluster that is already running they are three panels
          reading "Already done on this network" above the thing you came to
          do. Behind a disclosure they stay reachable for a fresh cluster
          without being the first 1,300px of the page. */}
      {showAdmin && (
      <Disclosure
        title="Network setup"
        subtitle={
          setupDone
            ? "Registry, price feed and approval are already configured on this network."
            : "Not finished on this network yet."
        }
        defaultOpen={!setupDone}
      >
        <RegistryNote />

      <Step
        n="01"
        tour="step-01"
        title="Set up the registry"
        done={done.factory}
        body="Done once per network. Whoever clicks this becomes the admin and is the only one who can approve prices and collateral after that."
        action={
          <Button
            disabled={busy || done.factory}
            onClick={() => run("factory", () => initFactoryIx(ctx))}
          >
            Initialize
          </Button>
        }
        status={activeAction === "factory" ? <TxStatus state={state} /> : null}
      />

      <Step
        n="02"
        tour="step-02"
        title="Point at a price feed"
        done={done.feed}
        body="Pins the SOL/USD settlement price and its approved Pyth account. The series cannot substitute another feed at expiry."
        action={
          <Button
            disabled={busy || done.feed}
            onClick={() =>
              run("feed", () =>
                initFeedConfigIx(
                  oracle,
                  publicKey!,
                  SOL_USD_FEED_ID,
                  DEVNET_PYTH_SOL_USD,
                  new BN(86_400),
                  0,
                ),
              )
            }
          >
            Create feed config
          </Button>
        }
        note={`config ${feedConfig.toBase58()}`}
        status={activeAction === "feed" ? <TxStatus state={state} /> : null}
      />

      <Step
        n="03"
        tour="step-03"
        title="Approve that price feed"
        done={done.oracle}
        body="Admin only. Stops anyone listing a series priced off a feed nobody checked."
        action={
          <Button
            disabled={busy || !done.factory || !done.feed || done.oracle || !isFactoryAdmin}
            onClick={() => run("oracle", () => approveOracleIx(ctx, feedConfig))}
          >
            Approve
          </Button>
        }
        status={activeAction === "oracle" ? <TxStatus state={state} /> : null}
      />
      </Disclosure>
      )}

      {showAdmin && (
      <Panel
        tour="admin-listing"
        title="List a market"
        subtitle="Choose the underlying, strike and expiry. A new collateral mint is approved automatically before the market is created."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextInput
              label="Underlying token mint"
              value={mint}
              onChange={editMint}
              placeholder="Paste the mint address from Demo setup"
            />
            {autofilled && (
              <p className="text-dim mt-1.5 text-[0.8rem]">
                Using the demo collateral created in this tab. The admin does not need to
                hold it.
              </p>
            )}
            {mint && !mintKey && (
              <p className="text-danger mt-1.5 text-sm">Not a valid address.</p>
            )}
          </div>
          <AmountInput
            label="Strike price (USD)"
            value={strike}
            onChange={(v) => {
              setStrike(v);
              reset();
            }}
            suffix="USD"
          />
          <AmountInput
            label="Days until expiry"
            value={days}
            onChange={(v) => {
              setDays(v);
              reset();
            }}
            suffix="days"
          />
        </div>

        {seriesAddress && (
          <p className="text-dim mt-3 font-mono text-[0.78rem] break-all">
            market series → {seriesAddress.toBase58()}
          </p>
        )}

        <div className="mt-4">
          <Button
            tone="accent"
            disabled={
              busy ||
              !setupDone ||
              !mintKey ||
              !isFactoryAdmin
            }
            onClick={() => void listContract()}
          >
            {listingPhase === "allowlisting"
              ? "Allowlisting mint…"
              : listingPhase === "creating"
                ? "Creating market…"
                : listingPhase === "activating"
                  ? "Opening live markets…"
                : done.collateral
                  ? "Create market"
                  : "Approve collateral and create market"}
          </Button>
        </div>

        <p className="text-dim mt-3 text-[0.8rem]">
          {done.collateral
            ? "This mint is already allowlisted. The P and N markets open automatically after listing."
            : "One guided action approves the mint, creates the series, and opens both live markets. Your wallet may request several approvals. If one is interrupted, retrying resumes from that step."}
        </p>

        <p className="text-dim mt-3 text-[0.8rem]">
          This valueless demo collateral is explicitly SOL-linked. Live spot comes from
          Pyth Lazer on MagicBlock; expiry settlement uses the approved Pyth SOL/USD
          account on Solana.
        </p>

        {adminNotice}
        {activeAction === "listing" && !listingError && <TxStatus state={state} />}
        {listingError && (
          <p className="text-danger mt-3 text-sm" role="alert">
            Market setup was interrupted. Retry to continue from the first unfinished step. {listingError}
          </p>
        )}
      </Panel>
      )}
    </div>
  );
}

/**
 * What the registry is, before the first step asks anyone to create one.
 *
 * "Initialize the factory" was the first thing on the page and it explained
 * nothing: it named a component of the system rather than saying what the thing
 * decides. The distinction it draws is the one nobody guesses, so it is stated
 * outright: creating a series is open to anyone, being listed is not.
 *
 * The limits are the ones enforced in `programs/factory/src/lib.rs`, not a
 * summary of intent. If those constants move, this moves.
 */
const REGISTRY_DOES: [string, string][] = [
  ["Which prices count", "A series can only settle against a feed the admin approved."],
  ["Which tokens count", "Same for collateral. An unapproved token cannot back a listed series."],
  [
    "Sane terms",
    "At least an hour to expiry, a price no more than a week old, a fee no higher than 10%.",
  ],
  ["Market discovery", "The Markets page reads this approved list and nothing else."],
];

function RegistryNote() {
  return (
    <Panel
      tour="registry-note"
      title="What the registry is for"
      subtitle="Four jobs, and a short list of things it deliberately cannot do."
    >
      <dl className="border-line grid border-y sm:grid-cols-2">
        {REGISTRY_DOES.map(([term, body]) => (
          <div key={term} className="border-line-soft border-b p-4 odd:sm:border-r">
            <dt className="text-[0.9rem]">{term}</dt>
            <dd className="text-muted mt-1 text-[0.88rem]">{body}</dd>
          </div>
        ))}
      </dl>

      <div className="border-line-soft mt-5 space-y-2 border-t pt-4">
        <p className="text-muted max-w-[68ch] text-[0.88rem]">
          Series can be created permissionlessly outside the registry, but only
          administrator-approved markets appear in Erodoro discovery.
        </p>
        <p className="text-dim max-w-[68ch] text-[0.88rem]">
          It holds no collateral and has no power over a series once that series exists. It
          cannot pause one, settle one, or move anything out of a vault. The admin decides
          what may be listed, and their say ends there.
        </p>
      </div>
    </Panel>
  );
}

/**
 * A section that starts closed. Used for the network-setup steps, which are
 * admin work nobody arriving at this page to list a contract needs to see.
 */
function Disclosure({
  title,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  // `defaultOpen` arrives false and flips once the on-chain reads land, so a
  // plain `useState(defaultOpen)` captures "not set up yet" and stays open
  // forever. Track the prop until someone actually clicks.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? Boolean(defaultOpen);
  return (
    <div className="border-line bg-panel rounded-md border">
      <button
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span>
          <span className="block text-[0.95rem]">{title}</span>
          {subtitle && <span className="text-dim mt-0.5 block text-[0.85rem]">{subtitle}</span>}
        </span>
        <span className="text-dim shrink-0 text-[0.85rem]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="space-y-4 px-5 pt-1 pb-5">{children}</div>}
    </div>
  );
}

function Step({
  n,
  title,
  body,
  done,
  action,
  note,
  notice,
  status,
  tour,
}: {
  n: string;
  title: string;
  body: string;
  done: boolean;
  action: React.ReactNode;
  note?: string;
  notice?: React.ReactNode;
  status?: React.ReactNode;
  tour?: string;
}) {
  return (
    <Panel
      tour={tour}
      title={`${n} · ${title}`}
      subtitle={done ? "Already done on this network." : undefined}
    >
      <p className="text-muted max-w-[62ch] text-[0.92rem]">{body}</p>
      <div className="mt-4 flex items-center gap-3">
        {action}
        {done && <span className="text-p text-sm">✓ done</span>}
      </div>
      {notice}
      {status}
      {note && <p className="text-dim mt-3 font-mono text-[0.75rem] break-all">{note}</p>}
    </Panel>
  );
}

function AdminNotice({
  admin,
  testRole,
  adminTestRole,
  onSwitch,
}: {
  admin: PublicKey;
  testRole: TestRole | null;
  adminTestRole: TestRole | null;
  onSwitch?: () => void;
}) {
  return (
    <div className="border-n/30 bg-n/5 mt-4 rounded-sm border px-4 py-3">
      <p className="text-n text-[0.88rem]">
        Only the factory admin can approve feeds or collateral, or create a listed market.
      </p>
      <p className="text-dim mt-1 font-mono text-[0.75rem] break-all">
        admin {admin.toBase58()}
      </p>
      {onSwitch && adminTestRole && (
        <div className="mt-3">
          <Button tone="accent" onClick={onSwitch}>
            Switch to {adminTestRole} admin
          </Button>
          {testRole && (
            <span className="text-dim ml-3 text-[0.8rem]">Currently signing as {testRole}.</span>
          )}
        </div>
      )}
    </div>
  );
}
