"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function LegacyAdminRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/admin/registry"), [router]);
  return (
    <div className="border-line bg-panel mx-auto mt-16 max-w-md rounded-md border p-8 text-center">
      <p className="text-muted text-sm">Opening the admin registry…</p>
    </div>
  );
}
