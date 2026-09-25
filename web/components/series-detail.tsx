"use client";

import { useEffect, useMemo, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { formatDate, priceToUsd, shortKey, statusOf, fromRaw } from "@/lib/format";
import type { LegName } from "@/lib/pdas";
import { SeriesActions, useClaimMint } from "./series-actions";
import { ManifestBookPanel } from "./manifest-book-panel";
import { StrategyPayoff } from "./strategy-payoff";
import { RoleToggle, useRole } from "./role-toggle";
import { AddressLink, Field, InfoDot, Tabs } from "./ui";
import { MagicBlockPricePanel, OraclePanel, OracleSafetyBanner } from "./oracle-panel";
import { useFeedId } from "@/lib/use-feed-id";
import { formatQuote, useOracleQuote } from "@/lib/use-oracle";
import { useTokenBalances } from "@/lib/use-token-balances";
import type { SeriesConfig, Settlement } from "@/lib/series-types";
import { claimDescription, claimLabel } from "@/lib/trading-ux";
import { ACTIVE_ISSUER } from "@/lib/issuers";
import { marketProfileForCollateral } from "@/lib/market-profile";
import { useMagicBlockPrice } from "@/lib/use-magicblock-price";

type DetailTab = "position" | "payoff" | "oracle" | "risks" | "details";

/**
 * One series in full: its terms, its settlement if it has one, the write
 * actions its lifecycle allows, and a book for each leg.
 *
 * Arranged by role. The protocol is symmetric but the two users are not: a
 * seller arrives holding a share and needs to mint before anything else is
 * useful, a buyer arrives holding cash and only needs the book. Same
 * components, different order, and the default leg follows the role because
 * the seller is selling N and the buyer is buying it.
 */
export function SeriesDetail({
  address,
  config,
  settlement,
  onBack,
  onDone,
  initialLeg = "N",
  onLegChange,
}: {
  address: PublicKey;
  config: SeriesConfig;
  settlement: Settlement | null;
  onBack: () => void;
  onDone: () => void;
  initialLeg?: LegName;
  onLegChange?: (leg: LegName) => void;
}) {
  const [role, setRole] = useRole();
  const [leg, setLegState] = useState<LegName>(initialLeg);
  const [advanced, setAdvanced] = useState(initialLeg === "P");
  const [detailTab, setDetailTab] = useState<DetailTab>("position");
  useEffect(() => setLegState(initialLeg), [initialLeg]);
  const setLeg = (next: LegName) => {
    setLegState(next);
    onLegChange?.(next);
  };

  const status = statusOf(config.status);
  const seller = role === "seller";
  const decimals = config.priceDecimals;
  const maturity = config.maturityTs.toNumber();
  const settled = status === "Settled";
  const matured = maturity <= Math.floor(Date.now() / 1000);

  // What this series will settle against, shown beside its terms.
  const feedId = useFeedId(config.oracleAdapter);
  const oracle = useOracleQuote(feedId);
  const issuerAsset = ACTIVE_ISSUER.asset(config.collateralMint.toBase58());
  const profile = marketProfileForCollateral(config.collateralMint.toBase58());
  const realtime = useMagicBlockPrice(profile?.realtime);
  const marketName = issuerAsset?.symbol || profile?.symbol || "UNKNOWN";

  const strikeNumber = Number(fromRaw(config.strike, decimals, decimals));
  const spotNumber =
    realtime.state.kind === "ready"
      ? realtime.state.price
      : oracle.state.kind === "ready"
        ? Number(fromRaw(oracle.state.quote.price, oracle.state.quote.decimals, oracle.state.quote.decimals))
        : null;
  const spot =
    realtime.state.kind === "ready"
      ? `$${realtime.state.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
      : oracle.state.kind === "ready"
        ? `$${formatQuote(oracle.state.quote.price, oracle.state.quote.decimals)}`
        : "—";
  const distance =
    spotNumber && spotNumber > 0 ? ((strikeNumber - spotNumber) / spotNumber) * 100 : null;

  // Locking collateral, handed to the ticket so a seller holding no N can mint
  // exactly what their order is short without leaving the form.
  const claimMint = useClaimMint({ address, config });
  const { state: balances } = useTokenBalances();
  // `null` means "not read yet", which is not the same as zero. Collapsing the
  // two made the ticket tell a seller they held no collateral, and disable the
  // action, during the second before their balance arrived.
  const collateralAvailable = useMemo(() => {
    if (balances.kind !== "ready") return null;
    return balances.holdings
      .filter((holding) => holding.mint === config.collateralMint.toBase58())
      .reduce((sum, holding) => sum + Number(fromRaw(holding.raw, holding.decimals, holding.decimals)), 0);
  }, [balances, config.collateralMint]);

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-muted hover:text-text -mt-2 inline-flex items-center gap-2 text-sm transition-colors"
      >
        <span aria-hidden>←</span> All markets
      </button>

      <section
        data-market-header
        data-tour="market-header"
        className="border-line bg-panel shadow-panel overflow-hidden rounded-md border"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 px-4 pt-4 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-medium tracking-[-0.04em] sm:text-3xl">
                {marketName}/USDC
              </h2>
              <span className="text-accent-ink font-mono text-lg">
                {priceToUsd(config.strike, decimals)}
              </span>
              <span className="text-dim text-sm">strike</span>
              <StatusPill status={status} matured={matured} />
            </div>
            <p className="text-dim mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
              <span>{profile?.name || "Tokenized-equity upside"}</span>
              <span aria-hidden>·</span>
              <span>expires {formatDate(maturity)}</span>
              <span aria-hidden>·</span>
              <span className="font-mono">{shortKey(address, 6)}</span>
            </p>
          </div>
          <div data-tour="role-toggle" className="shrink-0">
            <RoleToggle role={role} onChange={setRole} compact />
          </div>
        </div>

        <div className="border-line-soft grid grid-cols-2 gap-y-4 border-t px-4 py-3.5 sm:grid-cols-4 sm:divide-x sm:divide-[var(--color-line-soft)] lg:grid-cols-5">
          <Field
            label={realtime.state.kind === "ready" ? "Spot · MagicBlock" : "Spot · Pyth"}
            hint={
              realtime.state.kind === "ready"
                ? "Live price from MagicBlock."
                : "The Pyth feed this market settles against."
            }
          >
            {spot}
          </Field>
          <div className="sm:pl-4">
            <Field
              label="To strike"
              hint="How far the collateral has to move before N is worth anything at expiry."
            >
              {distance === null ? (
                "—"
              ) : (
                <span className={distance > 0 ? "text-n" : "text-p"}>
                  {distance > 0 ? "+" : ""}
                  {distance.toFixed(1)}%
                </span>
              )}
            </Field>
          </div>
          <div className="sm:pl-4">
            <Field label="Strike">{priceToUsd(config.strike, decimals)}</Field>
          </div>
          <div className="sm:pl-4">
            <Field label="Time remaining">
              {settled ? "settled" : <Countdown to={maturity} />}
            </Field>
          </div>
          <div className="col-span-2 sm:col-span-4 sm:border-t sm:border-[var(--color-line-soft)] sm:pt-4 lg:col-span-1 lg:border-t-0 lg:pt-0 lg:pl-4">
            <Field label="Your view">
              <span className={seller ? "text-ask" : "text-bid"}>
                {seller ? "Sell upside" : "Buy upside"}
              </span>
            </Field>
          </div>
        </div>

        {settlement && (
          <div className="border-line-soft grid grid-cols-2 gap-4 border-t px-4 py-3.5 sm:grid-cols-4">
            <Field label="Settled at">{priceToUsd(settlement.price, decimals)}</Field>
            <Field
              label="Effective strike"
              hint="The strike after any scaledUiAmount rebase, which is what settlement actually used."
            >
              {priceToUsd(settlement.effectiveStrike, decimals)}
            </Field>
            <Field label="P pool">{fromRaw(settlement.pPool, config.collateralDecimals)}</Field>
            <Field label="N pool">{fromRaw(settlement.nPool, config.collateralDecimals)}</Field>
            {settlement.supplyMismatch && (
              <p className="text-n col-span-full text-[0.85rem]">
                P and N supplies did not match at settlement. Someone burned tokens outside
                the app. Noted, not blocked, so nobody can freeze the series by doing it.
              </p>
            )}
          </div>
        )}
      </section>

      <OracleSafetyBanner state={oracle.state} />

      <ManifestBookPanel
        seriesAddress={address}
        leg={leg}
        onLegChange={setLeg}
        advanced={advanced}
        strike={strikeNumber}
        expiry={maturity}
        intent={role}
        onIntentChange={setRole}
        mint={
          settled || matured
            ? undefined
            : {
                buildSplit: claimMint.buildSplit,
                blocked: claimMint.blocked,
                collateralAvailable,
                collateralSymbol: marketName,
              }
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => {
            const next = !advanced;
            setAdvanced(next);
            if (!next) setLeg("N");
          }}
          className="border-line text-muted hover:border-text hover:text-text inline-flex items-center gap-2 rounded-sm border px-3 py-1.5 text-[0.8125rem] transition-colors"
        >
          <span aria-hidden className="font-mono text-[0.7rem]">
            {advanced ? "−" : "+"}
          </span>
          {advanced ? "Hide advanced P trading" : "Advanced trading · include P market"}
        </button>
        <span className="text-dim text-[0.75rem]">
          P is the capped equity claim. Most people only need N.
        </span>
      </div>

      <section data-market-education className="border-line bg-panel overflow-hidden rounded-md border">
        <Tabs
          label="Market information"
          value={detailTab}
          onChange={setDetailTab}
          options={[
            { value: "position" as const, label: "Position" },
            { value: "payoff" as const, label: "Payoff" },
            { value: "oracle" as const, label: "Oracle" },
            { value: "risks" as const, label: "Risks" },
            { value: "details" as const, label: "Details" },
          ]}
        />
        <div className="p-4">
          {detailTab === "position" && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Selected claim">
                  {claimLabel(leg)} ({leg})
                </Field>
                <Field label="Intent">{seller ? "Sell N for USDC" : "Buy N with USDC"}</Field>
                <Field label="Lifecycle">{status}</Field>
              </div>
              <SeriesActions
                flush
                address={address}
                config={config}
                settlement={settlement}
                onDone={onDone}
                tour="trade-action"
                priceSource={oracle.state.kind === "ready" ? oracle.state.config.source : undefined}
              />
            </div>
          )}
          {detailTab === "payoff" && (
            <div className="grid gap-6 lg:grid-cols-2">
              <PayoffPreview leg={leg} strike={priceToUsd(config.strike, decimals)} />
              {spotNumber !== null && spotNumber > 0 && strikeNumber > 0 && (
                <StrategyPayoff tokenSpot={spotNumber} tokenCap={strikeNumber} premium={null} />
              )}
            </div>
          )}
          {detailTab === "oracle" && (
            <div className="space-y-4">
              <MagicBlockPricePanel state={realtime.state} reload={realtime.reload} />
              <OraclePanel state={oracle.state} reload={oracle.reload} />
            </div>
          )}
          {detailTab === "risks" && (
            <div className="grid gap-5 md:grid-cols-3">
              <RiskItem title="Collateral downside">
                P follows the collateral below the strike. Selling N does not create downside
                protection.
              </RiskItem>
              <RiskItem title="Liquidity">
                An order may remain open, fill partially or have no opposing trader.
              </RiskItem>
              <RiskItem title="Issuer and oracle">
                Issuer controls and the configured settlement feed can affect redemption
                outcomes.
              </RiskItem>
            </div>
          )}
          {detailTab === "details" && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <AddressLink label="Series" address={address} />
              <AddressLink label="Collateral mint" address={config.collateralMint} />
              <AddressLink label="Oracle config" address={config.oracleAdapter} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status, matured }: { status: string; matured: boolean }) {
  const label = status === "Settled" ? "Settled" : matured ? "Awaiting settlement" : status;
  const tone =
    label === "Open"
      ? "border-p/40 bg-p/10 text-p"
      : label === "Settled"
        ? "border-line bg-panel-2 text-muted"
        : "border-n/40 bg-n/10 text-n";
  return (
    <span className={`rounded-sm border px-2 py-0.5 font-mono text-[0.7rem] tracking-[0.08em] uppercase ${tone}`}>
      {label}
    </span>
  );
}

/**
 * A countdown that actually counts down.
 *
 * The static "23d" was true when the page loaded and stayed on screen
 * unchanged for as long as the tab was open, which on the last day of a series
 * is the difference between "you have time" and "you do not".
 */
function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const left = to - now;
  if (left <= 0) return <span className="text-n">matured</span>;

  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);
  const seconds = left % 60;
  const urgent = left < 86_400;

  return (
    <span className={urgent ? "text-n" : undefined}>
      {days > 0
        ? `${days}d ${hours}h`
        : hours > 0
          ? `${hours}h ${String(minutes).padStart(2, "0")}m`
          : `${minutes}m ${String(seconds).padStart(2, "0")}s`}
    </span>
  );
}

function PayoffPreview({ leg, strike }: { leg: LegName; strike: string }) {
  const capped = leg === "P";
  return (
    <section data-payoff-preview className="border-line bg-bg overflow-hidden rounded-md border">
      <div className="border-line-soft flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="text-accent-ink font-mono text-[0.75rem] tracking-[0.12em] uppercase">
            At expiry
          </div>
          <h3 className="mt-1 flex items-center gap-1.5 text-sm font-medium">
            {claimLabel(leg)} ({leg})
            <InfoDot hint={claimDescription(leg)} />
          </h3>
          <p className="text-muted mt-1 text-xs">{claimDescription(leg)}</p>
        </div>
        <span className="border-line bg-panel text-muted rounded-sm border px-3 py-1.5 font-mono text-xs">
          strike {strike}
        </span>
      </div>
      <div className="grid items-stretch md:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]">
        <div className="border-line-soft relative min-h-36 border-b p-4 md:border-r md:border-b-0">
          <svg
            viewBox="0 0 320 120"
            className="h-28 w-full"
            role="img"
            aria-label={`${claimLabel(leg)} maturity payout shape`}
          >
            <line x1="18" y1="102" x2="304" y2="102" stroke="var(--chart-grid)" />
            <line x1="18" y1="102" x2="18" y2="12" stroke="var(--chart-grid)" />
            <line
              x1="186"
              y1="12"
              x2="186"
              y2="106"
              stroke="var(--color-accent)"
              strokeOpacity="0.45"
              strokeDasharray="4 4"
            />
            <polyline
              points={capped ? "18,102 186,30 304,30" : "18,102 186,102 304,30"}
              fill="none"
              stroke={capped ? "var(--color-p)" : "var(--color-accent)"}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text x="186" y="118" textAnchor="middle" fill="var(--chart-label)" fontSize="12">
              strike
            </text>
            <text x="22" y="14" fill="var(--chart-label)" fontSize="12">
              payout
            </text>
          </svg>
        </div>
        <dl className="grid grid-cols-3 divide-x divide-[var(--color-line-soft)]">
          <PayoffCase label="Below strike" value={capped ? "Follows the collateral down" : "Pays 0"} />
          <PayoffCase label="At strike" value={capped ? `Up to ${strike}` : "Pays 0"} />
          <PayoffCase
            label="Above strike"
            value={capped ? `Stays at ${strike}` : "Pays value above strike"}
          />
        </dl>
      </div>
      <p className="border-line-soft text-dim border-t px-4 py-2.5 text-[0.8125rem]">
        Payout is not profit. Your order price appears in the ticket before you submit.
      </p>
    </section>
  );
}

function PayoffCase({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-4">
      <dt className="text-dim text-[0.75rem] tracking-[0.08em] uppercase">{label}</dt>
      <dd className="text-muted mt-2 text-xs leading-5">{value}</dd>
    </div>
  );
}

function RiskItem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-danger text-sm font-medium">{title}</h3>
      <p className="text-muted mt-2 text-[0.8125rem] leading-6">{children}</p>
    </div>
  );
}
