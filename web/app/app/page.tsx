import type { Metadata } from "next";
import { SolanaProvider } from "@/components/solana-provider";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Markets · erodoro",
  description: "Browse tokenized-equity upside markets on erodoro.",
};

export default function AppPage() {
  return (
    <SolanaProvider>
      <AppShell />
    </SolanaProvider>
  );
}
