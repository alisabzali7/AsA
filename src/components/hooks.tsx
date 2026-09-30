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
import { createSequenceGuard } from "@/lib/poll-sequence";
import { decimalsFor } from "@/lib/chart/adapter";
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
  /**
   * IDENTITY RULE (merged from the Team-02 closure): the snapshot is stored
   * WITH the URL that produced it, and every field is returned only while
   * that URL is still the requested one. Switching symbol/timeframe can
   * therefore never keep painting the previous series' data.
   */
  const [snap, setSnap] = useState<{ url: string | null; data: T | null; error: string | null; status: ResourceStatus; failure: ResourceFailure | null }>({ url: null, data: null, error: null, status: "LOADING", failure: null });
  const [age, setAge] = useState<{ url: string | null; ms: number | null }>({ url: null, ms: null });
  const [staleAge, setStaleAge] = useState<{ url: string | null; ms: number | null }>({ url: null, ms: null });
  const lastOkAtRef = useRef<{ url: string; ms: number } | null>(null);
  const [tick, setTick] = useState(0);
  const onDataRef = useRef(onData);
  useEffect(() => { onDataRef.current = onData; });
  useEffect(() => {
    if (!enabled || !url) return;
    let dead = false;
    let activeController: AbortController | null = null;
    // overlapping polls of this URL may resolve out of order — only the newest
    // issued request may write state. Aborting the previous request also keeps
    // a fast symbol/timeframe switch from leaving orphaned network work behind.
    const seq = createSequenceGuard();
    const load = async () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const ticket = seq.issue();
      try {
        const r = await loadResource(url, { signal: controller.signal });
        if (r.status === "OK") {
          if (!dead && seq.accept(ticket)) {
            setSnap({ url, data: r.data as T, error: null, status: "OK", failure: null });
            setAge({ url, ms: 0 });
            lastOkAtRef.current = { url, ms: r.at_ms };
            setStaleAge({ url, ms: 0 });
            onDataRef.current?.(r.data as T);
          }
        } else {
          // never clear the last authoritative payload FOR THIS URL — the UI keeps
          // showing it with a decaying age (cached-not-live), which is truthful;
          // another URL's payload is NEVER inherited
          if (!dead && seq.accept(ticket)) setSnap((p) => ({ url, data: p.url === url ? p.data : null, error: r.failure ? r.failure.message : "request failed", status: r.status, failure: r.failure }));
        }
      } finally {
        if (activeController === controller) activeController = null;
      }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    const ageTimer = setInterval(() => {
      setAge((a) => (a.ms === null ? a : { url: a.url, ms: a.ms + 1000 }));
      const ok = lastOkAtRef.current;
      setStaleAge(ok ? { url: ok.url, ms: Date.now() - ok.ms } : { url: null, ms: null });
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
      activeController?.abort();
      clearInterval(timer);
      clearInterval(ageTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("asa:refresh", onBus);
    };
  }, [url, intervalMs, enabled, tick]);
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  const current = snap.url === url;
  return {
    data: current ? snap.data : null,
    error: current ? snap.error : null,
    loading: !current || snap.status === "LOADING",
    age_ms: age.url === url ? age.ms : null,
    refresh,
    status: current ? snap.status : "LOADING",
    failure: current ? snap.failure : null,
    stale_age_ms: staleAge.url === url ? staleAge.ms : null,
  };
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
    let closed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let onlineListener: (() => void) | null = null;
    const open = () => {
      if (closed) return;
      es?.close();
      try {
        es = new EventSource("/api/system/events?stream=1");
      } catch {
        setConnected(false);
        return;
      }
      es.onopen = () => {
        if (closed) return;
        setConnected(true);
        retries = 0;
      };
      es.onerror = () => {
        if (closed) return;
        setConnected(false);
        es?.close();
        retries++;
        // bounded backoff while offline; recovery is event-driven, not polling
        if (retries < 5) retryTimer = setTimeout(open, 3000 * retries);
      };
      es.onmessage = (ev) => {
        if (closed) return;
        try {
          const e = JSON.parse(ev.data) as { type: string; ts: number };
          setLastAt(e.ts);
          cbRef.current?.(e);
        } catch { /* heartbeat or partial */ }
      };
    };
    open();
    onlineListener = () => {
      if (closed) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retries = 0;
      open();
    };
    window.addEventListener("online", onlineListener);
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      es?.close();
      if (onlineListener) window.removeEventListener("online", onlineListener);
    };
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
  let digits: number;
  if (tick !== null && tick !== undefined && tick > 0 && tick < 1) digits = Math.min(12, Math.max(0, -Math.floor(Math.log10(tick))));
  else if (Math.abs(p) >= 1000) digits = 1;
  else digits = decimalsFor(p);
  return p.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
}

export { fmtAge };
