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
export const themePref = makePref<"dark" | "light">("asa-theme", "dark", (v) => {
  document.documentElement.dataset.theme = v;
  document.documentElement.classList.toggle("light", v === "light");
  document.documentElement.classList.toggle("dark", v !== "light");
});

/* -------------------------------------------------------- watchlist store */
const WATCHLIST_KEY = "asa-watchlist";
let watchlistCached: string[] | null = null;
const watchlistListeners = new Set<() => void>();

function readWatchlist(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  } catch {
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  }
}

function getWatchlistSnapshot(): string[] {
  const next = readWatchlist();
  if (!watchlistCached || watchlistCached.length !== next.length || watchlistCached.some((v, i) => v !== next[i])) {
    watchlistCached = next;
  }
  return watchlistCached;
}

function subscribeWatchlist(cb: () => void): () => void {
  watchlistListeners.add(cb);
  return () => { watchlistListeners.delete(cb); };
}

export function useWatchlist(): [string[], (symbol: string) => void, (symbols: string[]) => void] {
  const list = useSyncExternalStore(subscribeWatchlist, getWatchlistSnapshot, () => ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const toggle = useCallback((sym: string) => {
    const cur = readWatchlist();
    const next = cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym];
    try { window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    watchlistCached = next;
    watchlistListeners.forEach((l) => l());
  }, []);
  const setAll = useCallback((symbols: string[]) => {
    try { window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols)); } catch { /* ignore */ }
    watchlistCached = symbols;
    watchlistListeners.forEach((l) => l());
  }, []);
  return [list, toggle, setAll];
}
