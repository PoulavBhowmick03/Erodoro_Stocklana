import type { Metadata } from "next";
import { Suspense } from "react";
import { RipDetail } from "@/components/rips/rip-detail";
import { RipsShell } from "@/components/rips/rips-shell";

export const metadata: Metadata = { title: "Rip · erodoro" };

export default function RipPositionPage() {
  return (
    <RipsShell>
      {/* The id is a query parameter so the page can be prerendered once. */}
      <Suspense fallback={null}>
        <RipDetail />
      </Suspense>
    </RipsShell>
  );
}
