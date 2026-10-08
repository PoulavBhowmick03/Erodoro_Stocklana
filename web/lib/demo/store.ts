"use client";

import { useSyncExternalStore } from "react";
import { initialLedger, settleDue, type DemoLedger } from "./ledger";

const KEY = "erodoro.offline-demo.v1";
const listeners = new Set<() => void>();
let memory: DemoLedger | null = null;
let rawCache: string | null | undefined;
const server = initialLedger(0);

function snapshot() {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(KEY); } catch { /* Session memory works without storage. */ }
  if (memory && raw === rawCache) return memory;
  rawCache = raw;
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (value && typeof value.cash === "number" && Number.isFinite(value.cash) && value.cash >= 0 &&
      Array.isArray(value.positions) && Array.isArray(value.orders) && Array.isArray(value.capped) &&
      value.stocks && value.prices && value.activity && value.consumed && Number.isFinite(value.anchor)) {
      memory = { ...value, settlements: value.settlements ?? {} };
    } else memory ??= initialLedger();
  } catch { memory ??= initialLedger(); }
  return memory!;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) { memory = null; listener(); } };
  window.addEventListener("storage", storage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
}

/** All mutations read the latest snapshot, so fast clicks cannot spend stale balances. */
export function changeDemo(change: (s: DemoLedger) => DemoLedger) {
  const current = snapshot();
  const next = change(settleDue(current, Math.floor(Date.now() / 1000) + current.offset));
  memory = next;
  const raw = JSON.stringify(next);
  try { window.localStorage.setItem(KEY, raw); rawCache = raw; } catch { /* Keep the old cache and new memory. */ }
  listeners.forEach((listener) => listener());
  return next;
}

export function useDemoLedger() {
  return useSyncExternalStore(subscribe, snapshot, () => server);
}
