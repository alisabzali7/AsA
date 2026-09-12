"use client";
/** Shared data hooks: typed polling + SSE subscription + formatting. */
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtAge } from "@/lib/i18n/strings";

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
 *  setState synchronously inside an effect. */
export function usePoll<T>(url: string | null, intervalMs = 7000, enabled = true, onData?: (d: T) => void): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [age, setAge] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDataRef = useRef(onData);
  useEffect(() => { onDataRef.current = onData; });
  useEffect(() => {
    if (!enabled || !url) return;
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (!dead) { setData(j); setError(null); setAge(0); onDataRef.current?.(j); }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!dead) setLoading(false);
      }
    };
    void load();
    timer.current = setInterval(() => void load(), intervalMs);
    const ageTimer = setInterval(() => setAge((a) => (a === null ? null : a + 1000)), 1000);
    return () => { dead = true; if (timer.current) clearInterval(timer.current); clearInterval(ageTimer); };
  }, [url, intervalMs, enabled, tick]);
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, age_ms: age, refresh };
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
