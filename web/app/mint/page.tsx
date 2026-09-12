import { MintScreen } from "@/components/mint-screen";
import { AppChrome } from "@/components/app-chrome";
import { SolanaProvider } from "@/components/solana-provider";
import { IS_DEVNET } from "@/lib/network-config";

export const metadata = {
  title: IS_DEVNET ? "Create demo assets · erodoro" : "Demo setup unavailable · erodoro",
  description: IS_DEVNET
    ? "Mint valueless Token-2022 assets on Solana devnet to try Erodoro."
    : "Mainnet Erodoro accepts only approved issuer collateral.",
};

export default function MintPage() {
  return (
    <SolanaProvider>
      <AppChrome
        title={IS_DEVNET ? "Create demo assets" : "Demo setup unavailable"}
        lede={IS_DEVNET
          ? "Mint valueless Token-2022 assets on Solana devnet to try the complete Erodoro flow."
          : "Mainnet uses approved issuer assets. This build cannot create test collateral or test USDC."}
      >
        {IS_DEVNET ? <MintScreen /> : <MainnetUtilityNotice />}
      </AppChrome>
    </SolanaProvider>
  );
}

function MainnetUtilityNotice() {
  return (
    <section className="border-line bg-panel rounded-md border p-6">
      <h2 className="font-medium">Use an approved issuer asset</h2>
      <p className="text-muted mt-2 max-w-[62ch] text-sm leading-6">
        Demo minting is compiled out of the Mainnet flow. Approved collateral appears in
        Markets after the factory multisig lists its exact mint and settlement feed.
      </p>
    </section>
  );
}
