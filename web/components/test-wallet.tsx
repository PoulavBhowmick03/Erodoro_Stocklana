"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";

import { ADMIN_ROLE, USER_ROLES, TEST_ADDRESSES, testKeypair, testWalletsEnabled, type TestRole } from "@/lib/test-wallets";

/**
 * Which throwaway keypair is signing, if any.
 *
 * `null` means a real wallet is in charge and nothing here applies. The two
 * roles exist so a two-sided market can be driven from one browser: without
 * this, testing a trade means two extensions or a lot of disconnecting, and
 * the seller/buyer toggle changes the layout while the signer stays put —
 * which is worse than no toggle, because it looks like it worked.
 */
type Ctx = {
  role: TestRole | null;
  setRole: (r: TestRole | null) => void;
  keypair: Keypair | null;
  publicKey: PublicKey | null;
  enabled: boolean;
};

const TestWalletContext = createContext<Ctx>({
  role: null,
  setRole: () => {},
  keypair: null,
  publicKey: null,
  enabled: false,
});

const KEY = "erodoro.testWallet";

export function TestWalletProvider({ children }: { children: React.ReactNode }) {
  const enabled = testWalletsEnabled();
  const [role, setRoleState] = useState<TestRole | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const saved = window.localStorage.getItem(KEY);
    if (saved === "seller" || saved === "buyer") setRoleState(saved);
  }, [enabled]);

  const setRole = useCallback(
    (r: TestRole | null) => {
      setRoleState(r);
      if (r) window.localStorage.setItem(KEY, r);
      else window.localStorage.removeItem(KEY);
    },
    [],
  );

  const keypair = useMemo(() => (role ? testKeypair(role) : null), [role]);

  return (
    <TestWalletContext.Provider
      value={{
        role,
        setRole,
        keypair,
        publicKey: keypair?.publicKey ?? null,
        enabled,
      }}
    >
      {children}
    </TestWalletContext.Provider>
  );
}

export const useTestWallet = () => useContext(TestWalletContext);

/**
 * Pick a trader on user routes or the administrator on Registry, or hand
 * control back to a real wallet.
 *
 * Shows each address and its balance, because "which key am I signing with"
 * and "can it pay for this" are the two questions a test wallet exists to make
 * answerable at a glance.
 */
export function TestWalletBar({ registry = false, compact = false }: { registry?: boolean; compact?: boolean }) {
  const { connection } = useConnection();
  const { role, setRole, enabled } = useTestWallet();
  const [balances, setBalances] = useState<Record<string, number | null>>({});

  // Administration is a different job, not a third side of a trade. Keep its
  // fixture on Registry and keep trader fixtures everywhere else. If a route
  // change leaves the wrong kind selected, drop it rather than signing behind
  // a chip that is no longer visible.
  useEffect(() => {
    if (registry && role && role !== ADMIN_ROLE) setRole(null);
    if (!registry && role === ADMIN_ROLE) setRole(null);
  }, [registry, role, setRole]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = async () => {
      const next: Record<string, number | null> = {};
      const visibleRoles: TestRole[] = registry ? [ADMIN_ROLE] : USER_ROLES;
      for (const r of visibleRoles) {
        try {
          const { PublicKey } = await import("@solana/web3.js");
          next[r] = (await connection.getBalance(new PublicKey(TEST_ADDRESSES[r]))) / 1e9;
        } catch {
          next[r] = null;
        }
      }
      if (live) setBalances(next);
    };
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [connection, enabled, registry, role]);

  if (!enabled) return null;

  return (
    <div
      data-tour="test-keys"
      className={compact
        ? "border-line-soft border-t pt-3"
        : "border-line bg-panel mb-6 rounded-md border px-3 py-2 shadow-[0_1px_0_rgb(10_17_24/0.03)]"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-n mr-1 font-mono text-[0.8125rem] tracking-[0.12em] uppercase ${compact ? "basis-full" : ""}`}>
          {registry ? "test admin" : "demo account"}
        </span>
        {!registry && USER_ROLES.map((r) => (
          <button
            key={r}
            data-tour={`test-key-${r}`}
            onClick={() => setRole(role === r ? null : r)}
            aria-pressed={role === r}
            className={`max-w-full rounded-sm border px-3 py-1.5 text-sm transition-colors ${
              role === r
                ? "border-n text-n"
                : "border-line text-muted hover:text-text"
            }`}
          >
            {r}
            <span className="text-dim ml-2 font-mono text-[0.8125rem]">
              {balances[r] == null ? "…" : `${balances[r]!.toFixed(2)} ◎`}
            </span>
          </button>
        ))}

        {registry && (
          <button
            data-tour={`test-key-${ADMIN_ROLE}`}
            onClick={() => setRole(role === ADMIN_ROLE ? null : ADMIN_ROLE)}
            aria-pressed={role === ADMIN_ROLE}
            className={`max-w-full rounded-sm border px-3 py-1.5 text-sm transition-colors ${
              role === ADMIN_ROLE
                ? "border-accent text-accent-ink"
                : "border-line text-dim hover:text-text"
            }`}
          >
            {ADMIN_ROLE}
            <span className="text-dim ml-2 font-mono text-[0.8125rem]">
              {balances[ADMIN_ROLE] == null ? "…" : `${balances[ADMIN_ROLE]!.toFixed(2)} ◎`}
            </span>
          </button>
        )}
        {role && (
          <button
            onClick={() => setRole(null)}
            className="text-dim hover:text-text ml-1 text-sm underline-offset-2 hover:underline"
          >
            use my wallet
          </button>
        )}
      </div>
      <p className="text-dim mt-1.5 truncate text-[0.8125rem]">
        {role ? (
          <>
            Signing as <span className="text-n">{role}</span>{" "}
            <span className="font-mono">{TEST_ADDRESSES[role]}</span>
          </>
        ) : (
          registry
            ? "Throwaway devnet administrator. It never appears on trading screens."
            : "Throwaway devnet accounts. Choose the side you want to take."
        )}
      </p>
    </div>
  );
}
