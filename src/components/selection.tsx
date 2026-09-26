"use client";
/**
 * Cross-page selection store — the context that must SURVIVE navigation:
 * selected symbol, timeframe and the return route for the FLOW standard
 * (Home → Market → Chart → … never drops the user back to a blank state).
 * Browser-owned UI state (localStorage + subscription), NEVER backend truth:
 * nothing here asserts anything about the market; it only remembers what the
 * human last chose. Hydration-safe: the server snapshot is the empty default.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface AsaSelection { symbol: string | null; tf: string | null; returnTo: string | null }
const KEY = "asa-sel…ion";
const EMPTY: AsaSelection = { symbol: null, tf: null, returnTo: null };

let cached: AsaSelection | null = null;
const listeners = new Set<() => void>();

function read(): AsaSelection {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const j = JSON.parse(raw) as Partial<AsaSelection>;
    return {
      symbol: typeof j.symbol === "string" ? j.symbol : null,
      tf: typeof j.tf === "string" ? j.tf : null,
      returnTo: typeof j.returnTo === "string" ? j.returnTo : null,
    };
  } catch { return EMPTY; }
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot(): AsaSelection {
  // stable identity per stored value (useSyncExternalStore compares by ===)
  const next = read();
  if (!cached || cached.symbol !== next.symbol || cached.tf !== next.tf || cached.returnTo !== next.returnTo) cached = next;
  return cached;
}
function getServerSnapshot(): AsaSelection { return EMPTY; }

export function useSelection(): [AsaSelection, (patch: Partial<AsaSelection>) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((patch: Partial<AsaSelection>) => {
    const cur = getSnapshot();
    const next = { ...cur, ...patch };
    try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
    listeners.forEach((l) => l());
  }, []);
  return [value, set];
}

/* device-owned presentation preferences (explicitly NOT server settings) */
function makePref<T extends string>(key: string, def: T, apply?: (v: T) => void) {
  const ls: Set<() => void> = new Set();
  const get = (): T => {
    if (typeof window === "undefined") return def;
    try { return (window.localStorage.getItem(key) as T) || def; } catch { return def; }
  };
  const subscribe = (cb: () => void) => { ls.add(cb); return () => { ls.delete(cb); }; };
  const write = (v: T) => {
    try { window.localStorage.setItem(key, v); } catch { /* ignore */ }
    apply?.(v);
    ls.forEach((l) => l());
  };
  return {
    set: write,
    use(): [T, (v: T) => void] {
      const v = useSyncExternalStore(subscribe, get, () => def);
      return [v, useCallback((x: T) => write(x), [])];
    },
  };
}

export const densityPref = makePref<"comfortable" | "compact">("asa-density", "comfortable", (v) => {
  document.documentElement.dataset.density = v === "compact" ? "compact" : "comfortable";
});
export const motionPref = makePref<"full" | "reduced">("asa-motion", "full", (v) => {
  if (v === "reduced") document.documentElement.dataset.motion = "reduced";
  else delete document.documentElement.dataset.motion;
});
export const railPref = makePref<"expanded" | "compact">("asa-rail", "expanded", (v) => {
  document.documentElement.dataset.rail = v === "compact" ? "compact" : "expanded";
});
