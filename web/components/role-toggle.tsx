"use client";

import { useCallback, useEffect, useState } from "react";
import { useTestWallet } from "./test-wallet";
import type { TestRole } from "@/lib/test-wallets";

/**
 * Which side of the trade the page is being read from.
 *
 * The protocol is symmetric; the two users are not. A seller arrives holding a
 * share and wants cash for the upside. A buyer arrives holding cash and wants
 * the upside. They need the same screen arranged differently, and testing one
 * flow while the other is on screen is how a confusing layout survives review.
 *
 * Persisted, because reloading mid-flow and landing back on the other side's
 * view is exactly the friction this exists to find.
 */
/**
 * The two trading sides only. `TestRole` now also carries `admin`, which is a
 * registry authority rather than a side of the trade -- there is no seller/buyer
 * arrangement of the screen that means anything for it.
 */
export type Role = Exclude<TestRole, "admin">;

const KEY = "erodoro.role";

export function useRole(): [Role, (r: Role) => void] {
  const { role: testRole, setRole: setTestRole } = useTestWallet();
  const [savedRole, setSavedRole] = useState<Role>("seller");

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY);
    if (saved === "seller" || saved === "buyer") setSavedRole(saved);
  }, []);

  // A test key names the person it represents, so it is authoritative for the
  // matching layout too. Keeping a second persisted role behind it lets a real
  // wallet continue to use this toggle purely as a way to arrange the screen.
  useEffect(() => {
    if (!testRole || testRole === "admin") return;
    setSavedRole(testRole);
    window.localStorage.setItem(KEY, testRole);
  }, [testRole]);

  const set = useCallback(
    (r: Role) => {
      setSavedRole(r);
      window.localStorage.setItem(KEY, r);
      // With a test key active, changing sides must change both the screen and
      // the signer. Otherwise the app can claim to be buying while it signs as
      // the seller (or the inverse).
      if (testRole) setTestRole(r);
    },
    [testRole, setTestRole],
  );

  // Signing as the admin leaves the layout wherever it was: the admin is not
  // one of the two sides, so there is nothing for it to select.
  return [testRole && testRole !== "admin" ? testRole : savedRole, set];
}

const COPY: Record<Role, { label: string; hint: string; tone: string }> = {
  seller: {
    label: "I own the collateral",
    hint: "Lock tokenized equity, keep P and offer N for USDC.",
    tone: "text-ask",
  },
  buyer: {
    label: "I want exposure above the strike",
    hint: "Buy N for upside exposure. Maximum loss is the purchase price.",
    tone: "text-bid",
  },
};

export function RoleToggle({
  role,
  onChange,
  compact = false,
}: {
  role: Role;
  onChange: (r: Role) => void;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="border-line bg-panel grid grid-cols-2 rounded-sm border p-1">
        {(["seller", "buyer"] as Role[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            aria-pressed={role === r}
            className={`rounded-sm px-3 py-1.5 text-xs transition-colors ${
              role === r
                ? r === "seller"
                  ? "bg-ask/10 text-ask"
                  : "bg-bid/10 text-bid"
                : "text-dim hover:text-text"
            }`}
          >
            {r === "seller" ? "Sell upside" : "Buy upside"}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="border-line grid border-y md:grid-cols-2 md:divide-x md:divide-[var(--color-line)]">
      {(["seller", "buyer"] as Role[]).map((r) => {
          const active = role === r;
          return (
            <button
              key={r}
              onClick={() => onChange(r)}
              aria-pressed={active}
              className={`border-b-2 px-4 py-4 text-left transition-colors ${
                active ? "border-accent bg-panel" : "border-transparent hover:bg-panel/60"
              }`}
            >
              <div
                className={`font-mono text-[0.8125rem] tracking-[0.12em] uppercase ${
                  active ? COPY[r].tone : "text-dim"
                }`}
              >
                {r === "seller" ? "Sell upside" : "Buy upside"}
              </div>
              <div className={`mt-1 text-[0.95rem] ${active ? "text-text" : "text-muted"}`}>
                {COPY[r].label}
              </div>
              <div className="text-dim mt-0.5 text-[0.8rem]">{COPY[r].hint}</div>
            </button>
          );
      })}
    </div>
  );
}
