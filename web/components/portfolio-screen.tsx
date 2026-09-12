"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { manifestCancelIx, MANIFEST_PROGRAM_ID } from "@/lib/manifest";
import { useEphemeral } from "@/lib/rollup";
import { useSend } from "@/lib/use-send";
import { useSigner } from "@/lib/use-signer";
import { usePortfolioActivity, type LiveBalance, type OpenOrder } from "@/lib/use-portfolio-activity";
import { useCapabilities } from "@/lib/use-capabilities";
import { can, whyNot } from "@/lib/capabilities";
import { priceToUsd, shortKey } from "@/lib/format";
import { PositionsPanel } from "./positions-panel";
import { Button, EmptyState, LiveDot, Tabs, TxStatus } from "./ui";

type View = "positions" | "orders" | "balances";

/**
 * Portfolio, as the place that accounts for everything the signer has out.
 *
 * It used to show wallet positions only, which left two categories invisible:
 * an order resting on a book, and a balance sitting inside an execution session
 * rather than in the wallet. Both are real, both are the signer's, and neither
 * appeared anywhere in the app — so the only way to find a forgotten order was
 * to remember which market it was on and go back to it.
 */
export function PortfolioScreen() {
  const router = useRouter();
  const [view, setView] = useState<View>("positions");
  const activity = usePortfolioActivity();

  const open = useCallback(
    (address: string) => router.push(`/trade/markets?market=${address}&view=n`),
    [router],
  );

  return (
    <div className="space-y-4">
      <Tabs
        label="Portfolio views"
        value={view}
        onChange={setView}
        options={[
          { value: "positions" as const, label: "Positions" },
          {
            value: "orders" as const,
            label: activity.orders.length ? `Open orders (${activity.orders.length})` : "Open orders",
          },
          {
            value: "balances" as const,
            label: activity.balances.length
              ? `Live balances (${activity.balances.length})`
              : "Live balances",
          },
        ]}
      />

      {view === "positions" && <PositionsPanel onOpen={open} />}
      {view === "orders" && <OpenOrders activity={activity} onOpen={open} />}
      {view === "balances" && <LiveBalances activity={activity} onOpen={open} />}

      {activity.problems.length > 0 && view !== "positions" && (
        <p className="border-n/30 bg-n/8 text-n rounded-sm border px-3 py-2 text-[0.8rem]">
          {activity.problems.length === 1
            ? "One market could not be read, so anything held there is missing from this list."
            : `${activity.problems.length} markets could not be read, so anything held there is missing from this list.`}{" "}
          <button type="button" onClick={activity.reload} className="underline underline-offset-2">
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-2">
      {[0, 1].map((row) => (
        <div key={row} className="border-line bg-panel h-16 animate-pulse rounded-md border" />
      ))}
    </div>
  );
}

function OpenOrders({
  activity,
  onOpen,
}: {
  activity: ReturnType<typeof usePortfolioActivity>;
  onOpen: (address: string) => void;
}) {
  const signer = useSigner();
  const { connection: rollup } = useEphemeral();
  const { state, send } = useSend();
  const [cancelling, setCancelling] = useState<string | null>(null);

  const cancel = async (order: OpenOrder) => {
    if (!signer) return;
    setCancelling(order.sequence.toString());
    const signature = await send(
      async () => [manifestCancelIx(signer, order.market, order.sequence, MANIFEST_PROGRAM_ID)],
      rollup,
    );
    setCancelling(null);
    if (signature) activity.reload();
  };

  if (activity.loading) return <Loading />;
  if (!activity.orders.length) {
    return (
      <EmptyState
        title="No open orders"
        body="Orders you place rest here until they fill or you cancel them."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="border-line bg-panel shadow-panel hidden overflow-x-auto rounded-md border md:block">
        <table className="w-full min-w-[46rem] border-collapse text-left">
          <thead>
            <tr className="border-line-soft text-dim border-b text-[0.75rem] tracking-wide uppercase">
              <th className="px-3 py-2.5 font-normal">Market</th>
              <th className="px-3 py-2.5 font-normal">Side</th>
              <th className="px-3 py-2.5 text-right font-normal">Price</th>
              <th className="px-3 py-2.5 text-right font-normal">Remaining</th>
              <th className="px-3 py-2.5 text-right font-normal">Reserved</th>
              <th className="px-3 py-2.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {activity.orders.map((order) => (
              <tr key={`${order.market.toBase58()}-${order.sequence}`} className="border-line-soft border-b last:border-b-0">
                <td className="px-3 py-3">
                  <button
                    type="button"
                    onClick={() => onOpen(order.series.address.toBase58())}
                    className="hover:text-accent-ink text-left transition-colors"
                  >
                    <span className="font-medium">
                      {order.leg}/USDC
                    </span>
                    <span className="text-dim ml-2 text-[0.75rem]">
                      {priceToUsd(order.series.config.strike, order.series.config.priceDecimals)} strike
                    </span>
                    <span className="text-dim block font-mono text-[0.7rem]">
                      {shortKey(order.series.address, 4)}
                    </span>
                  </button>
                </td>
                <td className={`px-3 py-3 text-[0.85rem] ${order.side === "buy" ? "text-bid" : "text-ask"}`}>
                  {order.side === "buy" ? "Buy" : "Sell"}
                </td>
                <td className="px-3 py-3 text-right font-mono">{order.price.toLocaleString()}</td>
                <td className="px-3 py-3 text-right font-mono">{order.remaining.toLocaleString()}</td>
                <td className="px-3 py-3 text-right font-mono">
                  {order.lockedAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
                  <span className="text-dim text-[0.75rem]">{order.lockedSymbol}</span>
                </td>
                <td className="px-3 py-3 text-right">
                  <Button
                    size="sm"
                    busy={cancelling === order.sequence.toString()}
                    disabled={!order.cancellable}
                    disabledReason="This market is not in a live execution session, so orders cannot be changed right now."
                    onClick={() => void cancel(order)}
                  >
                    Cancel
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 md:hidden">
        {activity.orders.map((order) => (
          <div
            key={`${order.market.toBase58()}-${order.sequence}`}
            className="border-line bg-panel rounded-md border p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpen(order.series.address.toBase58())}
                className="text-left"
              >
                <div className="font-medium">{order.leg}/USDC</div>
                <div className="text-dim font-mono text-[0.7rem]">
                  {shortKey(order.series.address, 4)}
                </div>
              </button>
              <span className={`text-[0.8rem] ${order.side === "buy" ? "text-bid" : "text-ask"}`}>
                {order.side === "buy" ? "Buy" : "Sell"}
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[0.8rem]">
              <div>
                <dt className="text-dim text-[0.7rem] uppercase">Price</dt>
                <dd className="font-mono">{order.price.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-dim text-[0.7rem] uppercase">Remaining</dt>
                <dd className="font-mono">{order.remaining.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-dim text-[0.7rem] uppercase">Reserved</dt>
                <dd className="font-mono">
                  {order.lockedAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </dd>
              </div>
            </dl>
            <div className="mt-3">
              <Button
                size="sm"
                full
                busy={cancelling === order.sequence.toString()}
                disabled={!order.cancellable}
                disabledReason="This market is not in a live execution session, so orders cannot be changed right now."
                onClick={() => void cancel(order)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ))}
      </div>

      <TxStatus state={state} />
    </div>
  );
}

/**
 * Where the money is, named honestly.
 *
 * The one thing this must never do is imply that a balance inside a live
 * session is already back in the wallet. It is not, it cannot be returned while
 * the session holds the book, and the control that would return it does not
 * exist yet — so it is described, not offered.
 */
function LiveBalances({
  activity,
  onOpen,
}: {
  activity: ReturnType<typeof usePortfolioActivity>;
  onOpen: (address: string) => void;
}) {
  // Whether funds can be returned is a claim about this deployment, so it is
  // read from what has been established rather than from the network name.
  const capabilities = useCapabilities({
    sessionActive: activity.balances.some((entry) => entry.sessionActive),
  });
  const canExit = can(capabilities, "custody.exit");
  const exitBlockedBecause = whyNot(capabilities, "custody.exit");

  const onReturnToWallet = () => {
    // Unreachable while `custody.exit` is withheld, which it is on every
    // deployment today. When the gate opens this is where the commit, exit and
    // claim flow attaches -- as a TransactionFlow, like every other multi-step
    // action.
    throw new Error("Custody exit is not implemented for this deployment.");
  };

  if (activity.loading) return <Loading />;
  if (!activity.balances.length) {
    return (
      <EmptyState
        title="Nothing held in live execution"
        body="Balances moved into a MagicBlock session for trading appear here, separately from your wallet."
      />
    );
  }

  return (
    <div className="space-y-3">
      {activity.fundsInSession && (
        <div
          data-custody-note
          className={`rounded-sm border px-3 py-2.5 ${canExit ? "border-p/30 bg-p/8" : "border-n/30 bg-n/8"}`}
        >
          <p className={`text-[0.82rem] leading-5 ${canExit ? "text-p" : "text-n"}`}>
            These balances are held in a live execution session, not in your Solana wallet.
            You can trade and cancel with them now.
          </p>
          {canExit ? (
            <div className="mt-2.5">
              <Button size="sm" tone="accent" onClick={() => onReturnToWallet()}>
                Return all available balances to wallet
              </Button>
            </div>
          ) : (
            /* No control, and the reason. A button that cannot succeed is worse
               than an absent one, because a failure reads as the user's fault. */
            <p className="text-muted mt-1.5 text-[0.78rem] leading-5">
              Returning them to your wallet is not available on this deployment.{" "}
              {exitBlockedBecause}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-2">
        {activity.balances.map((entry) => (
          <BalanceCard key={`${entry.market.toBase58()}`} entry={entry} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function BalanceCard({
  entry,
  onOpen,
}: {
  entry: LiveBalance;
  onOpen: (address: string) => void;
}) {
  const amount = (value: number) =>
    value.toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <div className="border-line bg-panel rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen(entry.series.address.toBase58())}
          className="hover:text-accent-ink text-left transition-colors"
        >
          <span className="font-medium">{entry.leg}/USDC</span>
          <span className="text-dim ml-2 text-[0.75rem]">
            {priceToUsd(entry.series.config.strike, entry.series.config.priceDecimals)} strike
          </span>
          <span className="text-dim block font-mono text-[0.7rem]">
            {shortKey(entry.series.address, 4)}
          </span>
        </button>
        <span className="text-[0.75rem]">
          <LiveDot
            live={entry.sessionActive}
            label={entry.sessionActive ? "Live execution" : "Wallet custody"}
          />
        </span>
      </div>

      <dl className="border-line-soft mt-3 grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4">
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">{entry.leg} free</dt>
          <dd className="font-mono text-[0.9rem]">{amount(entry.freeBase)}</dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">{entry.leg} in orders</dt>
          <dd className="font-mono text-[0.9rem]">{amount(entry.lockedBase)}</dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">USDC free</dt>
          <dd className="font-mono text-[0.9rem]">{amount(entry.freeQuote)}</dd>
        </div>
        <div>
          <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">USDC in orders</dt>
          <dd className="font-mono text-[0.9rem]">{amount(entry.lockedQuote)}</dd>
        </div>
      </dl>
    </div>
  );
}
