import type { Metadata } from "next";
import { MyRips } from "@/components/rips/my-rips";
import { RipsShell } from "@/components/rips/rips-shell";

export const metadata: Metadata = { title: "My Rips · erodoro" };

export default function MyRipsPage() {
  return (
    <RipsShell>
      <MyRips />
    </RipsShell>
  );
}
