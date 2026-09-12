"use client";
/** Full board table over the DYNAMIC discovered universe (chart-centric, dense, truthful ages). */
import { useMemo, useRef, useState } from "react";
import { useLang } from "./lang";
import { usePoll, formatPrice, stateColor } from "./hooks";
import { StatusChip } from "./ui";

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

const TIMEFRAMES_COLORS = ["#3fb68b", "#d9605e"];

export function MarketBoard({ onFocus, compact = false }: { onFocus?: (s: string) => void; compact?: boolean }) {
  const { t } = useLang();
  const lastPrices = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, number>>({});
  const handleBoard = (b: BoardShape) => {
    // runs in the async fetch continuation: diff prices vs previous snapshot,
    // mark changed symbols, prune entries older than the flash window
    const nowTs = Date.now();
    const changed: Record<string, number> = {};
    const map: Record<string, number> = {};
    for (const r of b.rows) {
      if (r.price === null) continue;
      map[r.symbol] = r.price;
      if (lastPrices.current[r.symbol] !== undefined && lastPrices.current[r.symbol] !== r.price) changed[r.symbol] = nowTs;
    }
    lastPrices.current = map;
    setFlash((old) => {
      const next: Record<string, number> = {};
      for (const k of Object.keys(old)) if (nowTs - old[k] < 2500) next[k] = old[k];
      for (const k of Object.keys(changed)) next[k] = changed[k];
      return next;
    });
  };
  const { data, loading, error } = usePoll<BoardShape>("/api/market/board", 7000, true, handleBoard);
  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const [sortKey, setSortKey] = useState<"symbol" | "change" | "volume" | "funding">("symbol");
  const [dir, setDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    const arr = [...rows];
    const keyOf = (r: BoardRow): number | string => {
      switch (sortKey) {
        case "change": return r.change24hPct ?? -Infinity;
        case "volume": return r.volume24hQuote ?? -Infinity;
        case "funding": return r.fundingRate ?? 0;
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

  const head = (key: typeof sortKey, label: string) => (
    <th>
      <button className="focus-ring w-full text-left uppercase" onClick={() => { if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(key); setDir(1); } }}>
        {label}{sortKey === key ? (dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted">
          {t("board", "title")} · <span className="text-dim">{rows.length} rows (dynamic TTT universe) · stats endpoint /futures/markets/stats · sweep age {data?.stats_age_ms !== null && data?.stats_age_ms !== undefined ? `${Math.round((data.stats_age_ms ?? 0) / 1000)}s` : "…"}</span>
        </div>
        {error && <span className="text-[10px]" style={{ color: "#d9605e" }}>{error}</span>}
      </div>
      <div className="overflow-x-auto rounded-lg border hairline">
        <table className="tbl w-full border-collapse text-[12px]" style={{ minWidth: 860 }}>
          <thead>
            <tr>
              {head("symbol", t("market", "symbol"))}
              <th className="text-right">{t("market", "price")}</th>
              <th className="text-right">{t("market", "change24h")}</th>
              <th className="text-right">Vol 24h</th>
              <th className="text-right">{t("market", "funding")}</th>
              <th className="text-right">{t("market", "oi")}</th>
              <th>{t("market", "age")}</th>
              <th>{t("market", "lastUpdate")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const up = r.change24hPct !== null ? r.change24hPct >= 0 : null;
              const flashing = flash[r.symbol] !== undefined;
              const priceColor = r.price === null ? "var(--color-muted)" : "var(--color-text)";
              return (
                <tr key={r.symbol} className={r.focus ? "" : ""} style={r.focus ? { background: "rgba(212,184,116,0.05)" } : undefined}>
                  <td>
                    <button
                      className="focus-ring flex items-center gap-1.5 rounded px-1 py-0.5 font-semibold"
                      onClick={() => onFocus?.(r.symbol)}
                      title={r.focus ? "focus symbol" : "set focus"}
                      style={{ color: r.focus ? "#d4b874" : "inherit" }}
                    >
                      {r.symbol}
                      {r.focus && <span className="text-[8px] uppercase tracking-widest text-gold-dim">◉</span>}
                    </button>
                  </td>
                  <td className="mono text-right">
                    <span
                      className={`inline-block rounded px-1 ${flashing ? (up ? "flash-up" : "flash-down") : ""}`}
                      style={{ color: priceColor }}
                    >
                      {formatPrice(r.price, r.tick_size)}
                    </span>
                  </td>
                  <td className="mono text-right" style={{ color: up === null ? "var(--color-muted)" : up ? "#3fb68b" : "#d9605e" }}>
                    {r.change24hPct === null ? "—" : `${r.change24hPct >= 0 ? "+" : ""}${r.change24hPct.toFixed(2)}%`}
                  </td>
                  <td className="mono text-right text-dim">{r.volume24hQuote === null ? "—" : compact ? "" : `${(r.volume24hQuote / 1e6).toFixed(1)}M`}</td>
                  <td className="mono text-right" style={{ color: r.fundingRate === null ? "var(--color-muted)" : Math.abs(r.fundingRate) > 0.0001 ? "#d6a24a" : "var(--color-text)" }}>
                    {r.fundingRate === null ? "—" : `${(r.fundingRate * 100).toFixed(4)}%`}
                  </td>
                  <td className="mono text-right text-dim">{r.openInterest === null ? "—" : fmtO((r.openInterest))}</td>
                  <td>
                    <span className="mono text-[10px]" style={{ color: r.age_ms !== null && r.age_ms < 30000 ? "#3fb68b" : "#d6a24a" }}>
                      {r.age_ms === null ? "—" : `${Math.round((r.age_ms ?? 0) / 1000)}s`}
                    </span>
                  </td>
                  <td><StatusChip state={r.state} /></td>
                </tr>
              );
            })}
            {loading && rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted">loading first TTT snapshot…</td></tr>}
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

export { TIMEFRAMES_COLORS };
