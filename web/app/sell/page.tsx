"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export default function LegacySwapPage() {
  const router = useRouter();
  useEffect(() => router.replace("/swap?side=sell"), [router]);
  return <p className="p-6">Opening swap…</p>;
}
