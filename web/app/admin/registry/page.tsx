import type { Metadata } from "next";

import { AppChrome } from "@/components/app-chrome";
import { CreatePanel } from "@/components/create-panel";
import { SolanaProvider } from "@/components/solana-provider";
import { IS_DEVNET } from "@/lib/network-config";

export const metadata: Metadata = {
  title: "Admin registry · erodoro",
  description: IS_DEVNET
    ? "Approve feeds and collateral, then list markets in Erodoro discovery."
    : "Mainnet listings are reviewed and executed by the production multisig.",
};

export default function AdminRegistryPage() {
  return (
    <SolanaProvider>
      <AppChrome
        title="Admin registry"
        lede={IS_DEVNET
          ? "Approve settlement feeds and collateral types, then list markets in Erodoro discovery."
          : "Mainnet listings are executed through the production multisig and reviewed deployment manifest."}
      >
        {IS_DEVNET ? <CreatePanel /> : <MainnetRegistryNotice />}
      </AppChrome>
    </SolanaProvider>
  );
}

function MainnetRegistryNotice() {
  return (
    <section className="border-line bg-panel rounded-md border p-6">
      <h2 className="font-medium">Multisig-controlled listings</h2>
      <p className="text-muted mt-2 max-w-[62ch] text-sm leading-6">
        Browser-based registry bootstrapping is disabled on Mainnet. Issuer mints and
        settlement feeds must pass preflight, review, and multisig approval before the
        factory can list a market.
      </p>
    </section>
  );
}
