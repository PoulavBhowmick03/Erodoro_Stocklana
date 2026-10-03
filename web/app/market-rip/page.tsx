import type { Metadata } from "next";
import { RipsHome } from "@/components/rips/rips-home";
import { RipsShell } from "@/components/rips/rips-shell";

export const metadata: Metadata = {
  title: "Market Rip · erodoro",
  description: "$1. Pull a move. Each Rip buys a real fractional upside position.",
  openGraph: { title: "RIP $1 · erodoro", description: "$1. Pull a move.", type: "website" },
};

export default function Home() {
  return (
    <RipsShell>
      <RipsHome />
    </RipsShell>
  );
}
