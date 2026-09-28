"use client";
/**
 * 3D Dimensional Market Container (Home Market Section).
 *
 * Requirements:
 * - 10 assets in primary view inside a 3D-styled dimensional container.
 * - Displays: Symbol, Pair Symbol (e.g. BTC/USDT), Price, 24h Change, Volume 24h, State.
 * - "+ بیشتر" (+ More) button expands the container to show the full universe (e.g. all 63 markets).
 * - Clicking an asset handshakes with the chart workspace.
 * - Zero fabricated data: nulls remain "—" and states remain truthful.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useLang } from "./lang";
import { formatPrice, fmtAge, usePoll } from "./hooks";
import { effectiveAgeMs, displayStateFor } from "./board-selectors";
import { useSelection, useWatchlist } from "./selection";
import { Badge, StatusBadge } from "./ui";
import { IconChart, IconChevron, IconMarket, IconPin, IconPinFilled, IconTrendingDown, IconTrendingUp } from "./icons";

export interface MarketItem {
  symbol: string;
  pair: string;
  price: number | null;
  change24hPct: number | null;
  volume24hQuote: number | null;
  fundingRate: number | null;
  state: string;
  age_ms: number | null;
  tick_size: number | null;
}

interface BoardShape {
  ok: boolean;
  rows: {
    symbol: string;
    price: number | null;
    change24hPct: number | null;
    volume24hQuote: number | null;
    fundingRate: number | null;
    age_ms: number | null;
    state: string;
    tick_size: number | null;
  }[];
  stats_age_ms: number | null;
}

export function Market3DBox({ className = "" }: { className?: string }) {
  const { lang, t } = useLang();
  const [sel, setSel] = useSelection();
  const [watchlist, toggleWatchlist] = useWatchlist();
  const [expanded, setExpanded] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  const board = usePoll<BoardShape>("/api/market/board", 7000);
  const rows = useMemo(() => board.data?.rows ?? [], [board.data?.rows]);
  const boardReady = board.status === "OK";

  // Format pair (e.g. BTCUSDT -> BTC/USDT)
  const formatPair = (s: string) => {
    if (s.endsWith("USDT")) return `${s.slice(0, -4)}/USDT`;
    if (s.endsWith("USD")) return `${s.slice(0, -3)}/USD`;
    return s;
  };

  const filteredRows = useMemo(() => {
    if (!filterQuery.trim()) return rows;
    const q = filterQuery.trim().toLowerCase();
    return rows.filter((r) => r.symbol.toLowerCase().includes(q));
  }, [rows, filterQuery]);

  const visibleRows = useMemo(() => {
    if (expanded) return filteredRows;
    return filteredRows.slice(0, 10);
  }, [filteredRows, expanded]);

  return (
    <div
      className={`card overflow-hidden p-3 sm:p-5 transition-all duration-300 ${className}`}
      style={{
        background: "linear-gradient(180deg, rgba(216,188,120,0.02) 0%, rgba(14,17,24,0.95) 100%), var(--color-panel)",
        boxShadow: "0 10px 30px -10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      {/* Container Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b hairline pb-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-gold-3 text-gold bg-gold-dim shadow-sm">
            <IconMarket size={18} />
          </span>
          <div>
            <h2 className="text-sm font-bold text-text flex items-center gap-2">
              <span>{lang === "fa" ? "بازار زنده و دارایی‌های معاملاتی" : "Live Trading Markets"}</span>
              <span className="mono text-[10px] text-gold uppercase tracking-wider">
                {rows.length > 0 ? `${rows.length} ASSETS` : "DISCOVERY"}
              </span>
            </h2>
            <p className="text-[10px] text-dim">
              {lang === "fa"
                ? "داده‌های زنده TTT بدون دستکاری و قیمت‌های لحظه‌ای"
                : "Real TTT datafeed without synthetic substitutions"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {expanded && (
            <input
              type="text"
              placeholder={lang === "fa" ? "جستجوی جفت‌ارز…" : "Search pairs…"}
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="input !py-1 !px-2.5 text-xs w-[140px] sm:w-[180px]"
            />
          )}

          {/* + More Button */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="focus-ring btn btn-gold !py-1 text-xs gap-1.5 font-bold"
          >
            <span>
              {expanded
                ? lang === "fa" ? "نمای اولیه (۱۰ جفت)" : "Compact (10 Pairs)"
                : lang === "fa" ? "+ بیشتر (مشاهده تمام جفت‌ها)" : "+ More (All Markets)"}
            </span>
            <IconChevron size={12} className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
          </button>
        </div>
      </div>

      {/* 3D Dimensional Cards Grid */}
      <div
        className={`mt-4 grid gap-2.5 sm:gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 transition-all duration-300 ${
          expanded ? "max-h-[600px] overflow-y-auto pe-1" : ""
        }`}
        style={{ perspective: "1000px" }}
      >
        {visibleRows.map((r, i) => {
          const isUp = r.change24hPct !== null ? r.change24hPct >= 0 : null;
          const pair = formatPair(r.symbol);
          const isPinned = watchlist.includes(r.symbol);
          const age = effectiveAgeMs(r.age_ms, board.age_ms);
          const displayState = displayStateFor(r.state, age);

          return (
            <div
              key={r.symbol}
              className="group relative flex flex-col justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3 transition-all duration-200 hover:-translate-y-1 hover:border-gold-3 hover:shadow-lg"
              style={{
                transformStyle: "preserve-3d",
              }}
            >
              {/* Card Top: Pair & Pin */}
              <div className="flex items-start justify-between gap-1">
                <Link
                  href={`/chart?symbol=${r.symbol}`}
                  onClick={() => setSel({ symbol: r.symbol, returnTo: "/" })}
                  className="flex flex-col min-w-0 group-hover:text-gold"
                >
                  <span className="mono text-xs font-bold text-text truncate">{pair}</span>
                  <span className="mono text-[9px] text-dim">{r.symbol}</span>
                </Link>

                <button
                  onClick={() => toggleWatchlist(r.symbol)}
                  className="icon-btn !h-6 !w-6 hover:text-gold shrink-0"
                  title={isPinned ? "remove from watchlist" : "pin to watchlist"}
                >
                  {isPinned ? <IconPinFilled size={12} className="text-gold" /> : <IconPin size={12} />}
                </button>
              </div>

              {/* Card Middle: Price & 24h Change */}
              <div className="my-2 flex flex-col">
                <span className="mono text-sm sm:text-base font-black text-text">
                  {formatPrice(r.price, r.tick_size)}
                </span>
                <span
                  className="mono text-[11px] font-semibold flex items-center gap-0.5 mt-0.5"
                  style={{
                    color: isUp === true ? "var(--color-up)" : isUp === false ? "var(--color-down)" : "var(--color-muted)",
                  }}
                >
                  {isUp === true ? <IconTrendingUp size={11} /> : isUp === false ? <IconTrendingDown size={11} /> : null}
                  {r.change24hPct !== null ? `${isUp ? "+" : ""}${r.change24hPct.toFixed(2)}%` : "—"}
                </span>
              </div>

              {/* Card Bottom: Volume & State Badge */}
              <div className="flex items-center justify-between border-t hairline pt-1.5 text-[9.5px] text-dim mono">
                <span>{r.volume24hQuote ? `$${(r.volume24hQuote / 1e6).toFixed(1)}M` : "—"}</span>
                <StatusBadge state={displayState} />
              </div>
            </div>
          );
        })}

        {board.status === "LOADING" && visibleRows.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted text-xs">
            <span className="breathe">Loading dynamic TTT market universe…</span>
          </div>
        )}

        {boardReady && visibleRows.length === 0 && (
          <div className="col-span-full py-12 text-center text-dim text-xs">
            No markets match your query.
          </div>
        )}
      </div>

      {/* Footer info strip */}
      <div className="mt-3 flex flex-wrap items-center justify-between border-t hairline pt-2 text-[10px] text-dim">
        <span>
          Showing {visibleRows.length} of {rows.length} total universe pairs
        </span>
        <span className="mono">
          Sweep age: {board.data ? fmtAge(effectiveAgeMs(board.data.stats_age_ms, board.age_ms)) : "—"}
        </span>
      </div>
    </div>
  );
}
