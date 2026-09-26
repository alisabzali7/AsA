"use client";
/** Shared data hooks: typed polling + SSE subscription + formatting. */
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtAge } from "@/lib/i18n/strings";
import { createSequenceGuard } from "@/lib/poll-sequence";
import { decimalsFor } from "@/lib/chart/adapter";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  age_ms: number | null;
  refresh: () => void;
}

/** Poll a JSON endpoint at a cadence; also refreshable manually.
 *  `onData` (if given) runs in the async fetch continuation after each load —
 *  the correct place for components to react to fresh data without calling
 *  setState synchronously inside an effect.
 *
 *  Identity rule (Team 02): every response is stored WITH the URL that produced
 *  it, and only returned while that URL is still the requested one. Pre-fix,
 *  switching symbol/timeframe kept rendering the previous series' data (e.g.
 *  BTC S/R lines on an ETH chart) until the new response arrived. */
export function usePoll<T>(url: string | null, intervalMs = 7000, enabled = true, onData?: (d: T) => void): ApiState<T> {
  const [snap, setSnap] = useState<{ url: string | null; data: T | null; error: string | null; done: boolean }>({ url: null, data: null, error: null, done: false });
  const [age, setAge] = useState<{ url: string | null; ms: number | null }>({ url: null, ms: null });
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDataRef = useRef(onData);
  useEffect(() => { onDataRef.current = onData; });
  useEffect(() => {
    if (!enabled || !url) return;
    let dead = false;
    // Task 10: overlapping polls of this URL may resolve out of order — only
    // the newest issued request that resolves first-in-order may write state
    const seq = createSequenceGuard();
    const load = async () => {
      const ticket = seq.issue();
      try {
        const r = await fetch(url, { cache: "no-store" });
        // a non-2xx body may still carry a typed error_class — surface it
        if (!r.ok) {
          let cls = "";
          try { const b = (await r.json()) as { error_class?: string }; cls = b.error_class ? ` ${b.error_class}` : ""; } catch { /* non-JSON */ }
          throw new Error(`HTTP ${r.status}${cls}`);
        }
        const j = (await r.json()) as T;
        if (!dead && seq.accept(ticket)) { setSnap({ url, data: j, error: null, done: true }); setAge({ url, ms: 0 }); onDataRef.current?.(j); }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // keep this URL's last good data, but never another URL's
        if (!dead && seq.accept(ticket)) setSnap((p) => ({ url, data: p.url === url ? p.data : null, error: msg, done: true }));
      }
    };
    void load();
    timer.current = setInterval(() => void load(), intervalMs);
    const ageTimer = setInterval(() => setAge((a) => (a.ms === null ? a : { url: a.url, ms: a.ms + 1000 })), 1000);
    return () => { dead = true; if (timer.current) clearInterval(timer.current); clearInterval(ageTimer); };
  }, [url, intervalMs, enabled, tick]);
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  const current = snap.url === url;
  return {
    data: current ? snap.data : null,
    error: current ? snap.error : null,
    loading: !current || !snap.done,
    age_ms: age.url === url ? age.ms : null,
    refresh,
  };
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
    const open = () => {
      es = new EventSource("/api/system/events?stream=1");
      es.onopen = () => { setConnected(true); retries = 0; };
      es.onerror = () => { setConnected(false); es?.close(); retries++; if (retries < 5) setTimeout(open, 3000 * retries); };
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as { type: string; ts: number };
          setLastAt(e.ts);
          cbRef.current?.(e);
        } catch { /* heartbeat or partial */ }
      };
    };
    open();
    return () => { es?.close(); setConnected(false); };
  }, []);
  return { connected, lastAt };
}

export function stateColor(state: string): string {
  switch (state) {
    case "LIVE": case "READY": case "CONNECTED": return "#3fb68b";
    case "STALE": case "DEGRADED": case "PARTIAL": return "#d6a24a";
    case "CONNECTING": case "SCANNING": case "ANALYZING": case "RISK_CHECK": case "candidate": case "qualified": return "#8b8f99";
    case "UNAVAILABLE": case "ERROR": case "REJECTED": case "COOLDOWN": case "EXPIRED": case "blocked_by_risk": return "#d9605e";
    case "NOT_CONFIGURED": case "INSUFFICIENT_DATA": case "published": case "PENDING": return "#5d616b";
    default: return "#8b8f99";
  }
}

/**
 * Price label. With a venue tick, its decimals; otherwise ~5 significant
 * digits (Task 10: the old 6-decimal cap printed 1.23e-6 as "0.000001").
 */
export function formatPrice(p: number | null | undefined, tick?: number | null): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  let digits: number;
  if (tick !== null && tick !== undefined && tick > 0 && tick < 1) digits = Math.min(12, Math.max(0, -Math.floor(Math.log10(tick))));
  else if (Math.abs(p) >= 1000) digits = 1;
  else digits = decimalsFor(p);
  return p.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });
}

export { fmtAge };
