"use client";
/** Shared data hooks: normalized provider polling + SSE subscription + formatting.
 *
 *  The provider contract (see resource-state.ts): every poll carries an
 *  explicit status — LOADING / OK / UNAVAILABLE / OFFLINE / ERROR — plus the
 *  server's own verdict (state + reason) whenever a failure is a truthful
 *  "unavailable" answer rather than a fault. Features may format and
 *  downgrade freshness, never invent a success state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtAge } from "@/lib/i18n/strings";
import { loadResource, type ResourceFailure, type ResourceStatus } from "./resource-state";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  age_ms: number | null;
  refresh: () => void;
  /** normalized provider status — the state model the UI renders from */
  status: ResourceStatus;
  /** structured failure verdict (server state + reason) when not OK */
  failure: ResourceFailure | null;
  /** elapsed time since the LAST successful payload (null = never succeeded) */
  stale_age_ms: number | null;
}

/** Poll a JSON endpoint at a cadence; also refreshable manually.
 *  `onData` (if given) runs in the async fetch continuation after each load —
 *  the correct place for components to react to fresh data without calling
 *  setState synchronously inside an effect. */
export function usePoll<T>(url: string | null, intervalMs = 7000, enabled = true, onData?: (d: T) => void): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ResourceStatus>("LOADING");
  const [failure, setFailure] = useState<ResourceFailure | null>(null);
  const [age, setAge] = useState<number | null>(null);
  const [staleAge, setStaleAge] = useState<number | null>(null);
  const lastOkAtRef = useRef<number | null>(null);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDataRef = useRef(onData);
  useEffect(() => { onDataRef.current = onData; });
  useEffect(() => {
    if (!enabled || !url) return;
    let dead = false;
    const load = async () => {
      const r = await loadResource(url);
      if (dead) return;
      if (r.status === "OK") {
        setData(r.data as T);
        setError(null);
        setFailure(null);
        setAge(0);
        setStatus("OK");
        lastOkAtRef.current = r.at_ms;
        setStaleAge(0);
        onDataRef.current?.(r.data as T);
      } else {
        // never clear the last authoritative payload — the UI keeps showing it
        // with a decaying age (cached-not-live), which is the truthful behavior
        setStatus(r.status);
        setFailure(r.failure);
        setError(r.failure ? r.failure.message : "request failed");
      }
      setLoading(false);
    };
    void load();
    timer.current = setInterval(() => void load(), intervalMs);
    const ageTimer = setInterval(() => {
      setAge((a) => (a === null ? null : a + 1000));
      setStaleAge(lastOkAtRef.current === null ? null : Date.now() - lastOkAtRef.current);
    }, 1000);
    // OFFLINE recovery: the moment the browser is back, re-ask the server
    // instead of waiting for the next poll tick to flip the state.
    const onOnline = () => void load();
    window.addEventListener("online", onOnline);
    // global refresh bus (command-palette "Refresh all data"): re-ask now,
    // do not fake anything — a failed refresh keeps the honest prior state
    const onBus = () => void load();
    window.addEventListener("asa:refresh", onBus);
    return () => {
      dead = true;
      if (timer.current) clearInterval(timer.current);
      clearInterval(ageTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("asa:refresh", onBus);
    };
  }, [url, intervalMs, enabled, tick]);
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, age_ms: age, refresh, status, failure, stale_age_ms: staleAge };
}

/* ------------------------------------------------------------------ mutations
 *
 * Production deployments fail-closed on every mutation route unless
 * `x-asa-token` matches ASA_API_TOKEN (server env). The browser never learns
 * the token from the bundle: the operator may paste it once into Settings,
 * where it is kept ONLY in localStorage and attached to mutation requests.
 * Nothing about a denial is hidden — `postJson` surfaces the server's own
 * error message, and callers render it verbatim.
 */

export function asaToken(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem("asa-token"); } catch { return null; }
}

/* useSyncExternalStore seam for the stored token: hydration-safe (the server
 * snapshot is the empty "unknown" value) and reactive across tabs. */
const tokenListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "asa-token") tokenListeners.forEach((l) => l());
  });
}
export function subscribeAsaToken(cb: () => void): () => void {
  tokenListeners.add(cb);
  return () => { tokenListeners.delete(cb); };
}
export function getAsaTokenSnapshot(): string {
  return asaToken() ?? "";
}
export function getAsaTokenServerSnapshot(): string {
  return "";
}
export function setAsaToken(v: string | null): void {
  try {
    if (v) window.localStorage.setItem("asa-token", v);
    else window.localStorage.removeItem("asa-token");
    tokenListeners.forEach((l) => l());
  } catch { /* private mode */ }
}

/** POST/DELETE with the operator token attached. Returns parsed JSON + the
 *  HTTP ok flag; a network failure returns {ok:false, error} — never a fake
 *  success. */
export async function postJson<J = Record<string, unknown>>(
  url: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<{ ok: boolean; status: number; data: J | null; error: string | null }> {
  try {
    const token = asaToken();
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { "x-asa-token": token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    let parsed: (J & { ok?: boolean; error?: string }) | null = null;
    try { parsed = text.trim() ? (JSON.parse(text) as J & { ok?: boolean; error?: string }) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: parsed as J | null,
        error: parsed?.error ?? `HTTP ${res.status}`,
      };
    }
    if (parsed && parsed.ok === false) {
      return { ok: false, status: res.status, data: parsed as J, error: parsed.error ?? "server refused the operation" };
    }
    return { ok: true, status: res.status, data: parsed as J, error: null };
  } catch (e) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, data: null, error: offline ? `offline — request not sent (${msg})` : msg };
  }
}

/** Subscribe to the AsA SSE bus. Returns the latest matching events. */
export function useSse(onEvent?: (e: { type: string; ts: number }) => void): { connected: boolean; lastAt: number | null } {
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const cbRef = useRef(onEvent);
  useEffect(() => { cbRef.current = onEvent; }); // refs are written in effects, not render
  useEffect(() => {
    let retries = 0;
    let es: EventSource | null = null;
    let onlineListener: (() => void) | null = null;
    const open = () => {
      es = new EventSource("/api/system/events?stream=1");
      es.onopen = () => { setConnected(true); retries = 0; };
      es.onerror = () => {
        setConnected(false); es?.close(); retries++;
        // bounded backoff while offline; recovery is event-driven, not polling
        if (retries < 5) setTimeout(open, 3000 * retries);
      };
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as { type: string; ts: number };
          setLastAt(e.ts);
          cbRef.current?.(e);
        } catch { /* heartbeat or partial */ }
      };
    };
    open();
    onlineListener = () => { retries = 0; es?.close(); open(); };
    window.addEventListener("online", onlineListener);
    return () => { es?.close(); setConnected(false); if (onlineListener) window.removeEventListener("online", onlineListener); };
  }, []);
  return { connected, lastAt };
}

export function stateColor(state: string): string {
  switch (state) {
    case "LIVE": case "READY": case "CONNECTED": case "OK": return "var(--color-up)";
    case "STALE": case "DEGRADED": case "PARTIAL": case "UNAVAILABLE": case "NETWORK_FAILURE": case "NOT_READY": case "INVALID_RESPONSE": return "var(--color-warn)";
    case "CONNECTING": case "SCANNING": case "ANALYZING": case "RISK_CHECK": case "candidate": case "qualified": return "var(--color-muted)";
    case "OFFLINE": case "ERROR": case "REJECTED": case "COOLDOWN": case "EXPIRED": case "blocked_by_risk": return "var(--color-down)";
    case "NOT_CONFIGURED": case "INSUFFICIENT_DATA": case "published": case "PENDING": return "#5d616b";
    default: return "var(--color-muted)";
  }
}

export function formatPrice(p: number | null | undefined, tick?: number | null): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  let digits = 2;
  if (tick !== null && tick !== undefined && tick > 0 && tick < 1) digits = Math.min(10, Math.max(0, -Math.floor(Math.log10(tick))));
  else if (p < 0.01) digits = 6;
  else if (p < 1) digits = 4;
  else if (p < 1000) digits = 2;
  else digits = 1;
  return p.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits > 4 ? 4 : 2 });
}

export { fmtAge };
