import type { Metadata } from "next";
import { SolanaProvider } from "@/components/solana-provider";
import { AppChrome } from "@/components/app-chrome";
import { Panel } from "@/components/ui";

export const metadata: Metadata = {
  title: "Rewards · erodoro",
  description:
    "Current status of Erodoro points, loyalty, referrals, and partner rewards.",
};

const STATUS = [
  ["Erodoro Points", "Not active"],
  ["Season rank", "Not calculated"],
  ["Loyalty multiplier", "Not active"],
  ["Referral rewards", "Not active"],
  ["Partner rewards", "Not connected"],
] as const;

export default function RewardsPage() {
  return (
    <SolanaProvider>
      <AppChrome active="/rewards" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-n text-[0.75rem] tracking-[0.12em] uppercase">
              Program not active
            </p>
            <h1 className="font-display mt-2 text-3xl tracking-[-0.045em]">
              Rewards
            </h1>
            <p className="text-muted mt-3 max-w-[62ch] leading-7">
              No current action earns Erodoro Points. No partner reward follows
              a deposit into the Erodoro vault today.
            </p>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel heading="h2"
            title="Reward status"
            subtitle="No balances are estimated or backfilled"
          >
            <dl className="grid gap-3">
              {STATUS.map(([label, value]) => (
                <div
                  key={label}
                  className="border-line-soft flex items-center justify-between gap-4 border-t pt-3 first:border-0 first:pt-0"
                >
                  <dt className="text-muted text-sm">{label}</dt>
                  <dd className="font-mono text-sm tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel heading="h2" title="Season 0" subtitle="Draft: Founding Markets">
            <p className="text-muted text-sm leading-6">
              A season can direct activity toward selected stocks, sell prices,
              and expiries. The scoring rules need approval before activation.
            </p>
          </Panel>

          <Panel heading="h2"
            title="Activation requirements"
            subtitle="Publish these rules before points start"
          >
            <ul className="text-muted grid gap-2 text-sm leading-6 sm:grid-cols-2">
              <li>• Start slot and end slot</li>
              <li>• Eligible networks and contracts</li>
              <li>• Writer, buyer, and maker scoring</li>
              <li>• Time and maturity rules</li>
              <li>• Self-trade and circular-volume exclusions</li>
              <li>• Referral attribution and caps</li>
              <li>• Correction and appeal process</li>
              <li>• Administrator and data source</li>
            </ul>
          </Panel>

          <Panel heading="h2"
            title="Partner rewards"
            subtitle="Separate from Erodoro Points"
          >
            <p className="text-muted text-sm leading-6">
              External campaigns do not automatically recognize the beneficial
              owner of stock held by a vault. A distributor or direct partner
              integration must prove attribution first.
            </p>
          </Panel>
        </div>
      </main>
    </SolanaProvider>
  );
}
