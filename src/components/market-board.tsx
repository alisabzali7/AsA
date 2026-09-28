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
import { FilterBar, SearchInput, StatusBadge } from "./ui";
import { TruthState } from "./data-state";
import { useSelection, useWatchlist } from "./selection";
import { IconChart, IconInfo, IconPin, IconPinFilled } from "./icons";
import { MarketInspectorDrawer } from "./market-inspector";

export interface BoardRow {
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
export interface BoardShape { ok: boolean; rows: BoardRow[]; stats_age_ms: number | null; focus: string; ts: number }

interface FlashMark { at: number; up: boolean }
const WINDOW_ROWS = 60;

type FilterMode = "all" | "watchlist" | "gainers" | "losers" | "volume";
type SortKey = "symbol" | "price" | "change" | "volume" | "funding" | "oi" | "age";

export function MarketBoard({
  onFocus,
  compact = false,
  maxHeight = 620,
}: {
  onFocus?: (s: string) => void;
  compact?: boolean;
  maxHeight?: number;
}) {
  const { t } = useLang();
  const lastPrices = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, FlashMark>>({});
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [inspectedSymbol, setInspectedSymbol] = useState<string | null>(null);

  const [watchlist, toggleWatchlist] = useWatchlist();
  const [sel, setSel] = useSelection();

  const handleBoard = (b: BoardShape) => {
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

  const { data, status, failure, stale_age_ms, refresh, age_ms: sinceResponseMs } = usePoll<BoardShape>(
    "/api/market/board",
    7000,
    true,
    handleBoard
  );
  const boardReady = status === "OK" && !!data?.ok;
  const rows = useMemo(() => (boardReady ? data?.rows ?? [] : []), [boardReady, data?.rows]);

  const [sortKey, setSortKey] = useState<SortKey>("symbol");
  const [dir, setDir] = useState<1 | -1>(1);

  // Filter & Search
  const filteredRows = useMemo(() => {
    let result = rows;
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      result = result.filter((r) => r.symbol.toUpperCase().includes(q));
    }
    switch (filterMode) {
      case "watchlist":
        result = result.filter((r) => watchlist.includes(r.symbol));
        break;
      case "gainers":
        result = result.filter((r) => r.change24hPct != null && r.change24hPct > 0);
        break;
      case "losers":
        result = result.filter((r) => r.change24hPct != null && r.change24hPct < 0);
        break;
      case "volume":
        result = [...result].sort((a, b) => (b.volume24hQuote ?? 0) - (a.volume24hQuote ?? 0)).slice(0, 30);
        break;
      default:
        break;
    }
    return result;
  }, [rows, search, filterMode, watchlist]);

  const sorted = useMemo(() => {
    const arr = [...filteredRows];
    const keyOf = (r: BoardRow): number | string => {
      switch (sortKey) {
        case "price": return r.price ?? -Infinity;
        case "change": return r.change24hPct ?? -Infinity;
        case "volume": return r.volume24hQuote ?? -Infinity;
        case "funding": return r.fundingRate ?? -Infinity;
        case "oi": return r.openInterest ?? -Infinity;
        case "age": return r.age_ms ?? Infinity;
        default: return r.symbol;
      }
    };
    arr.sort((a, b) => {
      const va = keyOf(a), vb = keyOf(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return arr;
  }, [filteredRows, sortKey, dir]);

  /* ---- windowing for long universes: physical scroll, logical rows ---- */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(maxHeight);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rowH = 32;
  const needWindow = sorted.length > WINDOW_ROWS;
  const start = needWindow ? Math.max(0, Math.floor(scrollTop / rowH) - 4) : 0;
  const count = needWindow ? Math.min(sorted.length - start, Math.ceil(viewH / rowH) + 8) : sorted.length;
  const visible = sorted.slice(start, start + count);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const head = (key: SortKey, label: string, align: "start" | "end" = "start") => (
    <th className={`text-${align}`}>
      <button
        className="focus-ring w-full uppercase flex items-center gap-1 font-bold tracking-wider"
        style={{ justifyContent: align === "end" ? "flex-end" : "flex-start" }}
        aria-label={`sort by ${label}`}
        onClick={() => {
          if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1));
          else { setSortKey(key); setDir(key === "change" || key === "volume" || key === "oi" ? -1 : 1); }
        }}
      >
        <span>{label}</span>
        {sortKey === key && <span className="text-gold mono text-[9px]">{dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );

  const sweepEff = effectiveAgeMs(data?.stats_age_ms ?? null, sinceResponseMs);

  return (
    <div className="flex flex-col gap-2">
      {/* Search & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            onClear={() => setSearch("")}
            placeholder="Filter symbols (e.g. BTC, ETH)…"
            className="w-[220px]"
          />
          <FilterBar<FilterMode>
            active={filterMode}
            onChange={setFilterMode}
            filters={[
              { id: "all", label: "All Universe", count: rows.length },
              { id: "watchlist", label: "★ Watchlist", count: watchlist.length },
              { id: "gainers", label: "▲ Gainers" },
              { id: "losers", label: "▼ Losers" },
              { id: "volume", label: "💎 Top Vol" },
            ]}
          />
        </div>

        <div className="flex items-center gap-2 text-[10.5px] text-muted ms-auto">
          {boardReady && (
            <span>
              showing <strong className="text-text mono">{sorted.length}</strong> of <strong className="text-text mono">{rows.length}</strong> pairs
              {sweepEff !== null && <span className="text-dim"> · age {fmtAge(sweepEff)}</span>}
            </span>
          )}
          {needWindow && <span className="mono text-[9px] text-dim">windowed {start + 1}–{start + count}</span>}
        </div>
      </div>

      {!boardReady && (
        <div className="mb-1.5">
          <TruthState status={status} failure={failure} onRetry={refresh} staleAgeMs={data ? stale_age_ms : null} />
        </div>
      )}

      {/* Main Table */}
      <div
        ref={scrollRef}
        onScroll={needWindow ? onScroll : undefined}
        className="overflow-auto rounded-lg border hairline"
        style={{ maxHeight }}
      >
        <table className="tbl w-full border-collapse text-[12px]" style={{ minWidth: 880 }}>
          <caption className="sr-only">
            TTT market board — measured values only; unavailable data is reported by state, never substituted
          </caption>
          <thead>
            <tr>
              <th className="w-8 text-center" scope="col"><span className="sr-only">pin</span></th>
              {head("symbol", t("market", "symbol"), "start")}
              {head("price", t("market", "price"), "end")}
              {head("change", t("market", "change24h"), "end")}
              {head("volume", "Vol 24h", "end")}
              {head("funding", t("market", "funding"), "end")}
              {head("oi", t("market", "oi"), "end")}
              {head("age", t("market", "age"), "start")}
              <th scope="col">{t("market", "lastUpdate")}</th>
              <th className="w-20 text-center" scope="col">actions</th>
            </tr>
          </thead>
          <tbody>
            {needWindow && start > 0 && (
              <tr style={{ height: start * rowH }} aria-hidden>
                <td colSpan={10} style={{ padding: 0, border: 0 }} />
              </tr>
            )}
            {visible.map((r) => {
              const up = r.change24hPct !== null ? r.change24hPct >= 0 : null;
              const fl = flash[r.symbol];
              const effAge = effectiveAgeMs(r.age_ms, sinceResponseMs);
              const selected = sel.symbol === r.symbol;
              const isPinned = watchlist.includes(r.symbol);

              return (
                <tr
                  key={r.symbol}
                  data-selected={selected}
                  className="group hover:bg-[rgba(216,188,120,0.03)] cursor-pointer"
                  style={{ height: rowH, ...(r.focus && !selected ? { background: "rgba(216,188,120,0.045)" } : null) }}
                  onClick={() => {
                    setSel({ symbol: r.symbol });
                    setInspectedSymbol(r.symbol);
                  }}
                  onDoubleClick={() => {
                    setSel({ symbol: r.symbol });
                    onFocus?.(r.symbol);
                  }}
                >
                  <td className="text-center" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => toggleWatchlist(r.symbol)}
                      className="focus-ring icon-btn !h-6 !w-6 text-muted hover:text-gold"
                      title={isPinned ? "remove from watchlist" : "pin to watchlist"}
                      aria-pressed={isPinned}
                    >
                      {isPinned ? <IconPinFilled size={12} className="text-gold" /> : <IconPin size={12} />}
                    </button>
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <span style={{ color: r.focus || selected ? "var(--color-gold)" : "inherit" }}>
                        {r.symbol}
                      </span>
                      {(r.focus || selected) && <span className="text-[8px] uppercase tracking-widest text-gold">◉</span>}
                    </div>
                  </td>
                  <td className="mono text-end">
                    <span
                      className={`inline-block rounded px-1 ${fl ? (fl.up ? "flash-up" : "flash-down") : ""}`}
                      style={{
                        color:
                          r.price === null
                            ? "var(--color-muted)"
                            : fl
                            ? fl.up
                              ? "var(--color-up)"
                              : "var(--color-down)"
                            : "var(--color-text)",
                      }}
                    >
                      {formatPrice(r.price, r.tick_size)}
                    </span>
                  </td>
                  <td className="mono text-end font-medium" style={{ color: up === null ? "var(--color-muted)" : up ? "var(--color-up)" : "var(--color-down)" }}>
                    {r.change24hPct === null ? "—" : `${r.change24hPct >= 0 ? "+" : ""}${r.change24hPct.toFixed(2)}%`}
                  </td>
                  <td className="mono text-end text-dim">
                    {r.volume24hQuote === null ? "—" : compact ? "" : `$${(r.volume24hQuote / 1e6).toFixed(1)}M`}
                  </td>
                  <td
                    className="mono text-end"
                    style={{
                      color:
                        r.fundingRate === null
                          ? "var(--color-muted)"
                          : Math.abs(r.fundingRate) > 0.0001
                          ? "var(--color-warn)"
                          : "var(--color-text)",
                    }}
                  >
                    {r.fundingRate === null ? "—" : `${(r.fundingRate * 100).toFixed(4)}%`}
                  </td>
                  <td className="mono text-end text-dim">
                    {r.openInterest === null ? "—" : fmtO(r.openInterest)}
                  </td>
                  <td>
                    <span className="mono iso text-[10px]" style={{ color: effAge !== null && effAge < 30000 ? "var(--color-up)" : "var(--color-warn)" }}>
                      {effAge === null ? "—" : fmtAge(effAge)}
                    </span>
                  </td>
                  <td><StatusBadge state={displayStateFor(r.state, effAge)} /></td>
                  <td className="text-center" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-center gap-1">
                      <button
                        className="focus-ring icon-btn !h-6 !w-6 hover:text-gold"
                        title="open inspector"
                        onClick={() => setInspectedSymbol(r.symbol)}
                      >
                        <IconInfo size={12} />
                      </button>
                      <button
                        className="focus-ring icon-btn !h-6 !w-6 hover:text-gold"
                        title="open on chart"
                        onClick={() => {
                          setSel({ symbol: r.symbol });
                          onFocus?.(r.symbol);
                        }}
                      >
                        <IconChart size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {needWindow && start + count < sorted.length && (
              <tr style={{ height: (sorted.length - start - count) * rowH }} aria-hidden>
                <td colSpan={10} style={{ padding: 0, border: 0 }} />
              </tr>
            )}
            {status === "LOADING" && (
              <tr><td colSpan={10} className="py-6 text-center text-muted">requesting the first TTT snapshot…</td></tr>
            )}
            {status !== "LOADING" && !boardReady && (
              <tr>
                <td colSpan={10} className="py-6 text-center text-muted">
                  no board rows — {failure?.server_state ? `the provider reports ${failure.server_state}` : "no authoritative answer received yet"}
                </td>
              </tr>
            )}
            {boardReady && rows.length === 0 && (
              <tr><td colSpan={10} className="py-6 text-center text-muted">the universe answered, but has no rows yet</td></tr>
            )}
            {boardReady && rows.length > 0 && sorted.length === 0 && (
              <tr><td colSpan={10} className="py-6 text-center text-dim">No symbols match current search/filter</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Universe stats & windowing status footer */}
      {needWindow && (
        <div className="flex items-center justify-between border-t hairline px-3 py-1.5 text-[9.5px] text-dim">
          <span>showing {start + 1}–{Math.min(start + count, sorted.length)} of {sorted.length} ({count} windowed rows for smooth rendering)</span>
          <span>{rows.length} total universe symbols</span>
        </div>
      )}

      {/* Market Inspector Drawer */}
      {inspectedSymbol && (
        <MarketInspectorDrawer
          symbol={inspectedSymbol}
          onClose={() => setInspectedSymbol(null)}
        />
      )}
    </div>
  );
}

function fmtO(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
