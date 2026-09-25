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
const ROLE_CHANGED = "erodoro:role-changed";

export function useRole(): [Role, (r: Role) => void] {
  const { role: testRole, setRole: setTestRole } = useTestWallet();
  const [savedRole, setSavedRole] = useState<Role>("seller");

  useEffect(() => {
    const sync = () => {
      const saved = window.localStorage.getItem(KEY);
      if (saved === "seller" || saved === "buyer") setSavedRole(saved);
    };
    sync();
    window.addEventListener(ROLE_CHANGED, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ROLE_CHANGED, sync);
      window.removeEventListener("storage", sync);
    };
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
      window.dispatchEvent(new Event(ROLE_CHANGED));
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
    <div className="border-line inline-flex rounded-sm border p-0.5" role="group" aria-label="Your side">
      {(["seller", "buyer"] as Role[]).map(r => <button key={r} type="button" data-tour={r === "seller" ? "role-seller" : "role-buyer"}
        title={COPY[r].hint} aria-pressed={role === r} onClick={() => onChange(r)}
        className={`rounded-sm px-3 py-1.5 text-[0.8125rem] transition-colors ${role === r ? "bg-text text-bg font-medium" : "text-muted hover:text-text"}`}>
        {r === "seller" ? "I hold stock" : "I want upside"}
      </button>)}
    </div>
  );
}
