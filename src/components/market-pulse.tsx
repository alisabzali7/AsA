"use client";
/**
 * Market Pulse (نبض بازار) — Real-time market heartbeat.
 *
 * Requirements:
 * - Tracks primary instruments (BTCUSDT, ETHUSDT, SOLUSDT, etc., plus macro commodity proxies if provided by backend).
 * - Truthful representation: Never fabricates missing Gold/Silver/Brent feeds; displays authoritative unavailable state.
 * - Semantic line coloration: Green for genuine positive 24h change, Red for negative, neutral for unmeasured.
 * - Interactive hover with crosshair and exact price/change tooltip.
 * - "+ بیشتر" (+ More) expansion button to view all available universe pulse charts.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useLang } from "./lang";
import { formatPrice, usePoll } from "./hooks";
import { useSelection } from "./selection";
import { StatusBadge } from "./ui";
import { IconChevron, IconPulse, IconTrendingDown, IconTrendingUp } from "./icons";

interface PulsePoint {
  t: number;
  c: number;
}

interface PulseAsset {
  symbol: string;
  name: string;
  nameFa: string;
  category: "crypto" | "macro";
  price: number | null;
  change24hPct: number | null;
  available: boolean;
  history: PulsePoint[];
}

interface CandlesResponse {
  ok: boolean;
  symbol: string;
  candles: { t: number; c: number; o: number; h: number; l: number }[];
}

interface StatsResponse {
  ok: boolean;
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  state: string;
}

const PRIMARY_INSTRUMENTS = [
  { symbol: "BTCUSDT", name: "Bitcoin", nameFa: "بیت‌کوین", category: "crypto" as const },
  { symbol: "ETHUSDT", name: "Ethereum", nameFa: "اتریوم", category: "crypto" as const },
  { symbol: "SOLUSDT", name: "Solana", nameFa: "سولانا", category: "crypto" as const },
  { symbol: "PAXGUSDT", name: "Gold (PAXG)", nameFa: "طلا (PAXG)", category: "macro" as const },
  { symbol: "XAGUSD", name: "Silver", nameFa: "نقره", category: "macro" as const },
  { symbol: "BRENT", name: "Brent Oil", nameFa: "نفت برنت", category: "macro" as const },
];

export function MarketPulse({ className = "" }: { className?: string }) {
  const { lang, t } = useLang();
  const [, setSel] = useSelection();
  const [expanded, setExpanded] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string>("BTCUSDT");

  // Symbols universe poll
  const syms = usePoll<{ symbols: string[] }>("/api/market/symbols", 60000);
  const universe = useMemo(() => syms.data?.symbols ?? [], [syms.data]);

  // Active selected instrument candle history
  const activeCandles = usePoll<CandlesResponse>(
    `/api/market/candles?symbol=${selectedAsset}&tf=1h&limit=24`,
    20000
  );

  // Active selected instrument stats
  const activeStats = usePoll<StatsResponse>(
    `/api/market/stats?symbol=${selectedAsset}`,
    8000
  );

  // Board poll for quick rates across universe
  const board = usePoll<{ ok: boolean; rows: { symbol: string; price: number | null; change24hPct: number | null; state: string }[] }>(
    "/api/market/board",
    10000
  );

  const rows = useMemo(() => board.data?.rows ?? [], [board.data?.rows]);
  const rowsMap = useMemo(() => {
    const map = new Map<string, { price: number | null; change24hPct: number | null; state: string }>();
    for (const r of rows) map.set(r.symbol, r);
    return map;
  }, [rows]);

  // Combine known primary instruments with actual backend availability
  const assets = useMemo<PulseAsset[]>(() => {
    const list: PulseAsset[] = [];

    for (const item of PRIMARY_INSTRUMENTS) {
      const isDiscovered = universe.includes(item.symbol);
      const row = rowsMap.get(item.symbol);
      list.push({
        symbol: item.symbol,
        name: item.name,
        nameFa: item.nameFa,
        category: item.category,
        price: row?.price ?? null,
        change24hPct: row?.change24hPct ?? null,
        available: isDiscovered || Boolean(row && row.state !== "UNAVAILABLE"),
        history: [],
      });
    }

    // If expanded, append other active universe crypto instruments
    if (expanded) {
      for (const s of universe.slice(0, 18)) {
        if (!list.some((a) => a.symbol === s)) {
          const row = rowsMap.get(s);
          list.push({
            symbol: s,
            name: s.replace("USDT", ""),
            nameFa: s.replace("USDT", ""),
            category: "crypto",
            price: row?.price ?? null,
            change24hPct: row?.change24hPct ?? null,
            available: true,
            history: [],
          });
        }
      }
    }

    return list;
  }, [universe, rowsMap, expanded]);

  // Active instrument points for the pulse chart
  const points = useMemo<PulsePoint[]>(() => {
    if (activeCandles.data?.ok && activeCandles.data.candles) {
      return activeCandles.data.candles.map((c) => ({ t: c.t, c: c.c }));
    }
    return [];
  }, [activeCandles.data]);

  const activeRow = rowsMap.get(selectedAsset);
  const activePrice = activeStats.data?.price ?? activeRow?.price ?? null;
  const activeChange = activeStats.data?.change24hPct ?? activeRow?.change24hPct ?? null;
  const isUp = activeChange !== null ? activeChange >= 0 : null;

  return (
    <div className={`card overflow-hidden p-3 sm:p-4 ${className}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2.5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md border border-gold-3 text-gold bg-gold-dim">
            <IconPulse size={16} />
          </span>
          <div>
            <h2 className="text-[13px] font-bold text-text flex items-center gap-2">
              <span>{lang === "fa" ? "نبض بازار" : "Market Pulse"}</span>
              <span className="mono text-[9px] text-gold uppercase tracking-wider">24H Line</span>
            </h2>
            <p className="text-[10px] text-dim">
              {lang === "fa" ? "ضربان ۲۴ ساعته دارایی‌های شاخص" : "24h heartbeat of major market assets"}
            </p>
          </div>
        </div>

        {/* Action / More Button */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="focus-ring btn !py-1 text-[10.5px] gap-1"
          >
            <span>{expanded ? (lang === "fa" ? "کمتر" : "Less") : (lang === "fa" ? "+ بیشتر" : "+ More")}</span>
            <IconChevron size={11} className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
          </button>
        </div>
      </div>

      {/* Main Pulse Display Area */}
      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_260px]">
        {/* Left: Interactive Mini Pulse Chart */}
        <div className="flex flex-col justify-between rounded-lg border hairline bg-[var(--color-ink)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2">
            <div className="flex items-baseline gap-2">
              <span className="mono text-base sm:text-lg font-bold text-text">{selectedAsset}</span>
              <span className="mono text-sm font-semibold">
                {activePrice !== null ? formatPrice(activePrice) : "—"}
              </span>
              <span
                className="mono text-xs font-semibold flex items-center gap-0.5"
                style={{
                  color: isUp === true ? "var(--color-up)" : isUp === false ? "var(--color-down)" : "var(--color-muted)",
                }}
              >
                {isUp === true ? <IconTrendingUp size={12} /> : isUp === false ? <IconTrendingDown size={12} /> : null}
                {activeChange !== null ? `${isUp ? "+" : ""}${activeChange.toFixed(2)}%` : "—"}
              </span>
            </div>

            <Link
              href={`/chart?symbol=${selectedAsset}`}
              onClick={() => setSel({ symbol: selectedAsset, returnTo: "/" })}
              className="focus-ring btn !py-0.5 text-[10px] text-gold"
            >
              Open Terminal →
            </Link>
          </div>

          {/* SVG Pulse Line Graph */}
          <div className="relative h-[120px] sm:h-[140px] w-full pt-3">
            {points.length > 1 ? (
              <PulseSvg points={points} isUp={isUp} />
            ) : (
              <div className="flex h-full items-center justify-center text-center text-[11px] text-dim">
                {activeCandles.status === "LOADING" ? (
                  <span className="breathe">Loading pulse stream…</span>
                ) : (
                  <span>Authoritative 24h history unavailable for {selectedAsset}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Instrument Switcher Carousel / Grid */}
        <div className="flex flex-col gap-1.5 max-h-[220px] overflow-y-auto pe-1">
          {assets.map((asset) => {
            const isSelected = selectedAsset === asset.symbol;
            const assetUp = asset.change24hPct !== null ? asset.change24hPct >= 0 : null;

            return (
              <button
                key={asset.symbol}
                onClick={() => {
                  if (asset.available) setSelectedAsset(asset.symbol);
                }}
                disabled={!asset.available}
                className={`focus-ring flex items-center justify-between rounded-md border p-2 text-start transition-all ${
                  isSelected
                    ? "border-gold-2 bg-[rgba(216,188,120,0.08)] shadow-sm"
                    : "border-[var(--color-line)] bg-[var(--color-panel-2)] hover:border-gold-3"
                } ${!asset.available ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="mono text-[11.5px] font-bold text-text truncate">
                      {lang === "fa" ? asset.nameFa : asset.name}
                    </span>
                    {asset.category === "macro" && (
                      <span className="rounded bg-[var(--color-line-2)] px-1 py-0.2 text-[8px] font-bold text-dim">
                        MACRO
                      </span>
                    )}
                  </div>
                  <span className="mono text-[9.5px] text-dim">{asset.symbol}</span>
                </div>

                <div className="flex flex-col items-end shrink-0">
                  {asset.available ? (
                    <>
                      <span className="mono text-[11.5px] font-semibold text-text">
                        {formatPrice(asset.price)}
                      </span>
                      <span
                        className="mono text-[10px] font-medium"
                        style={{
                          color: assetUp === true ? "var(--color-up)" : assetUp === false ? "var(--color-down)" : "var(--color-muted)",
                        }}
                      >
                        {asset.change24hPct !== null ? `${assetUp ? "+" : ""}${asset.change24hPct.toFixed(2)}%` : "—"}
                      </span>
                    </>
                  ) : (
                    <StatusBadge state="UNAVAILABLE" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PulseSvg({ points, isUp }: { points: PulsePoint[]; isUp: boolean | null }) {
  const minP = Math.min(...points.map((p) => p.c));
  const maxP = Math.max(...points.map((p) => p.c));
  const range = maxP - minP || 1;

  const w = 500;
  const h = 100;
  const pad = 10;

  const pathData = useMemo(() => {
    return points
      .map((p, i) => {
        const x = pad + (i / (points.length - 1)) * (w - pad * 2);
        const y = h - pad - ((p.c - minP) / range) * (h - pad * 2);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points, minP, range]);

  const strokeColor =
    isUp === true ? "#43c495" : isUp === false ? "#e46a68" : "#8f95a3";
  const gradientId = `pulse-grad-${isUp === true ? "up" : isUp === false ? "down" : "neut"}`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full overflow-visible" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
        </linearGradient>
      </defs>

      {/* Area fill */}
      <path
        d={`${pathData} L ${w - pad} ${h} L ${pad} ${h} Z`}
        fill={`url(#${gradientId})`}
      />

      {/* Main crisp line */}
      <path
        d={pathData}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
