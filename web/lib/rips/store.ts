"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ACTIVE_NETWORK } from "../network-config";
import type { RipPosition } from "./model";

/**
 * Where Rips are remembered.
 *
 * Live positions are on chain; what lives here is the part the chain does not
 * keep in a readable form -- which lot a Rip came from, what was paid, the
 * signature. Demo positions exist only here. Storage can be unavailable
 * (private windows, blocked site data), so every access is guarded and the
 * app still works for the session in memory.
 */

const PREFIX = "erodoro.rips.v1";
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    // Fall through to the in-memory copy.
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The in-memory copy still serves this session.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith(PREFIX)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Positions are per network and per owner; demo has its own book. */
export function positionsKey(owner: string | null, demo: boolean) {
  return `${PREFIX}:${ACTIVE_NETWORK}:${demo ? "demo" : (owner ?? "none")}`;
}

const parsed = new Map<string, { raw: string | null; value: unknown }>();
function parse<T>(key: string, fallback: T): T {
  const raw = read(key);
  const hit = parsed.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: unknown = fallback;
  try {
    if (raw) value = JSON.parse(raw);
  } catch {
    value = fallback;
  }
  parsed.set(key, { raw, value });
  return value as T;
}

const EMPTY: RipPosition[] = [];
const EMPTY_MAP: Record<string, number> = {};

export function useStoredPositions(key: string) {
  const positions = useSyncExternalStore(
    subscribe,
    () => parse<RipPosition[]>(key, EMPTY),
    () => EMPTY,
  );
  const save = useCallback(
    (next: RipPosition[]) => write(key, JSON.stringify(next)),
    [key],
  );
  return { positions, save };
}

/** How much of each demo lot has been ripped on this device. */
const CONSUMED = `${PREFIX}:${ACTIVE_NETWORK}:demo-consumed`;
export function useDemoConsumed() {
  const consumed = useSyncExternalStore(
    subscribe,
    () => parse<Record<string, number>>(CONSUMED, EMPTY_MAP),
    () => EMPTY_MAP,
  );
  const consume = useCallback((lotId: string, usd: number) => {
    const current = parse<Record<string, number>>(CONSUMED, EMPTY_MAP);
    write(CONSUMED, JSON.stringify({ ...current, [lotId]: (current[lotId] ?? 0) + usd }));
  }, []);
  return { consumed, consume };
}

