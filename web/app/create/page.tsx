import { LegacyAdminRedirect } from "@/components/legacy-admin-redirect";
import { SolanaProvider } from "@/components/solana-provider";

export const metadata = {
  title: "Admin registry · erodoro",
  description: "Compatibility link for the erodoro admin registry.",
};

export default function CreatePage() {
  return (
    <SolanaProvider>
      <LegacyAdminRedirect />
    </SolanaProvider>
  );
}
