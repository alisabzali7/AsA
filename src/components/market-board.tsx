"use client";
/**
 * Full board table over the DYNAMIC discovered universe — the flagship
 * "living data" surface. Discipline (mission §15, §77):
 *  · flashes fire ONLY on a real snapshot diff (up/down from last payload)
 *  · no fake +0.00%, no zero-substitution: nulls stay "—" with honest state
 *  · long universes (>60 rows) are windowed; scroll stays smooth, DOM stays small
 *  · sweep age decays client-side: a cached board never re-looks fresh
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "./lang";
import { usePoll, formatPrice, fmtAge } from "./hooks";
import { effectiveAgeMs, displayStateFor } from "./board-selectors";
import { StatusBadge } from "./ui";
import { TruthState } from "./data-state";
import { useSelection } from "./selection";

interface BoardRow {
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  volume24hQuote: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  age_ms: number | null;
  state: string;
  tick_size: number | null;
  focus: boolean;
}
interface BoardShape { ok: boolean; rows: BoardRow[]; stats_age_ms: number | null; focus: string; ts: number }

interface FlashMark { at: number; up: boolean }
const WINDOW_ROWS = 60;

export function MarketBoard({ onFocus, compact = false, maxHeight = 560 }: { onFocus?: (s: string) => void; compact?: boolean; maxHeight?: number }) {
  const { t } = useLang();
  const lastPrices = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, FlashMark>>({});
  const handleBoard = (b: BoardShape) => {
    // runs in the async fetch continuation: diff vs previous REAL snapshot
    const nowTs = Date.now();
    const changed: Record<string, FlashMark> = {};
    const map: Record<string, number> = {};
    for (const r of b.rows) {
      if (r.price === null) continue;
      map[r.symbol] = r.price;
      const prev = lastPrices.current[r.symbol];
      if (prev !== undefined && prev !== r.price) changed[r.symbol] = { at: nowTs, up: r.price > prev };
    }
    lastPrices.current = map;
    setFlash((old) => {
      const next: Record<string, FlashMark> = {};
      for (const k of Object.keys(old)) if (nowTs - old[k].at < 2500) next[k] = old[k];
      for (const k of Object.keys(changed)) next[k] = changed[k];
      return next;
    });
  };
  const { data, status, failure, stale_age_ms , refresh, age_ms: sinceResponseMs } = usePoll<BoardShape>("/api/market/board", 7000, true, handleBoard);
  const boardReady = status === "OK" && !!data?.ok;
  const rows = useMemo(() => (boardReady ? data?.rows ?? [] : []), [boardReady, data?.rows]);
  const [sortKey, setSortKey] = useState<"symbol" | "change" | "volume" | "funding">("symbol");
  const [dir, setDir] = useState<1 | -1>(1);
  const [sel, setSel] = useSelection();

  const sorted = useMemo(() => {
    const arr = [...rows];
    const keyOf = (r: BoardRow): number | string => {
      switch (sortKey) {
        case "change": return r.change24hPct ?? -Infinity;
        case "volume": return r.volume24hQuote ?? -Infinity;
        case "funding": return r.fundingRate ?? -Infinity;
        default: return r.symbol;
      }
    };
    arr.sort((a, b) => {
      const va = keyOf(a), vb = keyOf(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return arr;
  }, [rows, sortKey, dir]);

  /* ---- windowing for long universes: physical scroll, logical rows ---- */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(maxHeight);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return; // DOM-only API
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rowH = 30;
  const needWindow = sorted.length > WINDOW_ROWS;
  const start = needWindow ? Math.max(0, Math.floor(scrollTop / rowH) - 4) : 0;
  const count = needWindow ? Math.min(sorted.length - start, Math.ceil(viewH / rowH) + 8) : sorted.length;
  const visible = sorted.slice(start, start + count);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const head = (key: typeof sortKey, label: string) => (
    <th>
      <button
        className="focus-ring w-full text-start uppercase"
        aria-label={`sort by ${label}`}
        onClick={() => { if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(key); setDir(1); } }}
      >
        {label}{sortKey === key ? (dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  // Effective (client-elapsed) age of the whole sweep: the server's frozen
  // stats_age_ms plus time since this snapshot arrived. Keeps ticking while
  // offline, so a cached board can never keep pretending it is fresh.
  const sweepEff = effectiveAgeMs(data?.stats_age_ms ?? null, sinceResponseMs);

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted">
          {t("board", "title")} · <span className="text-dim">{boardReady ? `${rows.length} rows (dynamic TTT universe) · sweep age ${sweepEff !== null ? fmtAge(sweepEff) : "…"}` : "state provider — see status below"}</span>
        </div>
        {needWindow && <span className="mono text-[9px] text-dim">windowed rows {start + 1}–{start + count}</span>}
      </div>
      {!boardReady && (
        <div className="mb-1.5">
          <TruthState status={status} failure={failure} onRetry={refresh} staleAgeMs={data ? stale_age_ms : null} />
        </div>
      )}
      <div ref={scrollRef} onScroll={needWindow ? onScroll : undefined} className="overflow-auto rounded-lg border hairline" style={{ maxHeight }}>
        <table className="tbl w-full border-collapse text-[12px]" style={{ minWidth: 860 }}>
          <caption className="sr-only">TTT market board — measured values only; unavailable data is reported by state, never substituted</caption>
          <thead>
            <tr>
              {head("symbol", t("market", "symbol"))}
              <th className="text-end" scope="col">{t("market", "price")}</th>
              <th className="text-end" scope="col">{t("market", "change24h")}</th>
              <th className="text-end" scope="col">Vol 24h</th>
              <th className="text-end" scope="col">{t("market", "funding")}</th>
              <th className="text-end" scope="col">{t("market", "oi")}</th>
              <th scope="col">{t("market", "age")}</th>
              <th scope="col">{t("market", "lastUpdate")}</th>
            </tr>
          </thead>
          <tbody>
            {needWindow && start > 0 && <tr style={{ height: start * rowH }} aria-hidden><td colSpan={8} style={{ padding: 0, border: 0 }} /></tr>}
            {visible.map((r) => {
              const up = r.change24hPct !== null ? r.change24hPct >= 0 : null;
              const fl = flash[r.symbol];
              const effAge = effectiveAgeMs(r.age_ms, sinceResponseMs);
              const selected = sel.symbol === r.symbol;
              return (
                <tr key={r.symbol} data-selected={selected} style={{ height: rowH, ...(r.focus && !selected ? { background: "rgba(216,188,120,0.045)" } : null) }}>
                  <td>
                    <button
                      className="focus-ring flex items-center gap-1.5 rounded px-1 py-0.5 font-semibold"
                      onClick={() => { setSel({ symbol: r.symbol }); onFocus?.(r.symbol); }}
                      title={r.focus ? "selected focus symbol" : "select symbol for the whole terminal"}
                      style={{ color: r.focus || selected ? "var(--color-gold)" : "inherit" }}
                    >
                      {r.symbol}
                      {(r.focus || selected) && <span className="text-[8px] uppercase tracking-widest text-gold">◉</span>}
                    </button>
                  </td>
                  <td className="mono text-end">
                    <span
                      className={`inline-block rounded px-1 ${fl ? (fl.up ? "flash-up" : "flash-down") : ""}`}
                      style={{ color: r.price === null ? "var(--color-muted)" : fl ? (fl.up ? "var(--color-up)" : "var(--color-down)") : "var(--color-text)" }}
                    >
                      {formatPrice(r.price, r.tick_size)}
                    </span>
                  </td>
                  <td className="mono text-end" style={{ color: up === null ? "var(--color-muted)" : up ? "var(--color-up)" : "var(--color-down)" }}>
                    {r.change24hPct === null ? "—" : `${r.change24hPct >= 0 ? "+" : ""}${r.change24hPct.toFixed(2)}%`}
                  </td>
                  <td className="mono text-end text-dim">{r.volume24hQuote === null ? "—" : compact ? "" : `${(r.volume24hQuote / 1e6).toFixed(1)}M`}</td>
                  <td className="mono text-end" style={{ color: r.fundingRate === null ? "var(--color-muted)" : Math.abs(r.fundingRate) > 0.0001 ? "var(--color-warn)" : "var(--color-text)" }}>
                    {r.fundingRate === null ? "—" : `${(r.fundingRate * 100).toFixed(4)}%`}
                  </td>
                  <td className="mono text-end text-dim">{r.openInterest === null ? "—" : fmtO(r.openInterest)}</td>
                  <td>
                    <span className="mono iso text-[10px]" style={{ color: effAge !== null && effAge < 30000 ? "var(--color-up)" : "var(--color-warn)" }}>
                      {effAge === null ? "—" : fmtAge(effAge)}
                    </span>
                  </td>
                  <td><StatusBadge state={displayStateFor(r.state, effAge)} /></td>
                </tr>
              );
            })}
            {needWindow && start + count < sorted.length && <tr style={{ height: (sorted.length - start - count) * rowH }} aria-hidden><td colSpan={8} style={{ padding: 0, border: 0 }} /></tr>}
            {status === "LOADING" && <tr><td colSpan={8} className="py-6 text-center text-muted">requesting the first TTT snapshot…</td></tr>}
            {status !== "LOADING" && !boardReady && (
              <tr><td colSpan={8} className="py-6 text-center text-muted">no board rows — {failure?.server_state ? `the provider reports ${failure.server_state}` : "no authoritative answer received yet"}</td></tr>
            )}
            {boardReady && rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">the universe answered, but has no rows yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtO(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
