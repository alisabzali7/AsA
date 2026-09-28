"use client";
/**
 * AsA 3D Dimensional Order Book Component
 *
 * Requirements:
 * - Real bids and asks from /api/market/orderbook?symbol=...
 * - Semantic Green for actual bids, Red for actual asks.
 * - Depth bars with percentage volume visualization.
 * - 3D perspective tilt and hover depth elevation.
 * - Real-time flash on price/quantity updates.
 * - Mobile responsive design with compact / expanded view.
 */
import { useMemo, useState } from "react";
import { formatPrice, usePoll } from "./hooks";
import { useLang } from "./lang";
import { useSelection } from "./selection";
import { Badge, StatusBadge } from "./ui";
import { IconChart, IconLayers } from "./icons";

interface OrderbookShape {
  ok: boolean;
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  ts: number;
}

interface StatsShape {
  ok: boolean;
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  tick_size: number | null;
}

export function Orderbook3D({ symbol: propSymbol, className = "" }: { symbol?: string; className?: string }) {
  const { lang, t } = useLang();
  const [sel, setSel] = useSelection();
  const [depthLimit, setDepthLimit] = useState<number>(8);

  const activeSymbol = propSymbol || sel.symbol || "BTCUSDT";

  const obPoll = usePoll<OrderbookShape>(`/api/market/orderbook?symbol=${activeSymbol}`, 4000);
  const statsPoll = usePoll<StatsShape>(`/api/market/stats?symbol=${activeSymbol}`, 6000);

  const ob = obPoll.data;
  const stats = statsPoll.data;
  const tickSize = stats?.tick_size ?? null;

  const bids = useMemo(() => (ob?.bids ?? []).slice(0, depthLimit), [ob?.bids, depthLimit]);
  const asks = useMemo(() => (ob?.asks ?? []).slice(0, depthLimit), [ob?.asks, depthLimit]);

  // Calculate cumulative depth for visual volume bars
  const maxBidQty = useMemo(() => Math.max(...bids.map((b) => b[1]), 1), [bids]);
  const maxAskQty = useMemo(() => Math.max(...asks.map((a) => a[1]), 1), [asks]);
  const maxQty = Math.max(maxBidQty, maxAskQty);

  const bestBid = bids[0]?.[0] ?? null;
  const bestAsk = asks[0]?.[0] ?? null;
  const spread = bestBid && bestAsk ? Math.abs(bestAsk - bestBid) : null;
  const spreadPct = spread && bestBid ? (spread / bestBid) * 100 : null;

  return (
    <div
      className={`card overflow-hidden p-3 sm:p-4 ${className}`}
      style={{
        transformStyle: "preserve-3d",
      }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2.5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md border border-gold-3 text-gold bg-gold-dim">
            <IconLayers size={15} />
          </span>
          <div>
            <h2 className="text-[13px] font-bold text-text flex items-center gap-2">
              <span>{lang === "fa" ? "دفتر سفارشات سه‌بعدی" : "Dimensional Order Book"}</span>
              <span className="mono text-[10px] text-gold">{activeSymbol}</span>
            </h2>
            <p className="text-[10px] text-dim">
              {lang === "fa" ? "عمق زنده بازار و توزیع حجم" : "Live depth & liquidity distribution"}
            </p>
          </div>
        </div>

        {/* Depth limit toggle */}
        <div className="flex items-center gap-1">
          {[6, 8, 12].map((n) => (
            <button
              key={n}
              onClick={() => setDepthLimit(n)}
              className={`focus-ring btn !py-0.5 !px-1.5 text-[9.5px] ${depthLimit === n ? "btn-active" : ""}`}
            >
              {n}L
            </button>
          ))}
        </div>
      </div>

      {/* Main Order Book Grid (Asks Top, Spread Center, Bids Bottom) */}
      <div className="mt-3 flex flex-col gap-1">
        {/* Asks (Sell Side - Red) */}
        <div className="flex flex-col gap-0.5">
          <div className="flex justify-between px-2 text-[9.5px] uppercase font-bold text-dim tracking-wider">
            <span>Price (USDT)</span>
            <span>Size</span>
            <span>Sum</span>
          </div>

          <div className="flex flex-col-reverse gap-0.5">
            {asks.map(([p, q], i) => {
              const widthPct = Math.min(100, (q / maxQty) * 100);
              return (
                <div
                  key={`ask-${p}-${i}`}
                  className="relative flex items-center justify-between rounded px-2 py-1 text-[11px] mono transition-colors hover:bg-[rgba(228,106,104,0.08)]"
                >
                  {/* Visual Depth Bar */}
                  <div
                    className="absolute inset-y-0 end-0 rounded-s opacity-20 pointer-events-none transition-all duration-300"
                    style={{
                      width: `${widthPct}%`,
                      background: "var(--color-down)",
                    }}
                  />
                  <span className="font-semibold" style={{ color: "var(--color-down)" }}>
                    {formatPrice(p, tickSize)}
                  </span>
                  <span className="text-text">{q.toFixed(2)}</span>
                  <span className="text-dim text-[10px]">{(p * q).toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Spread / Mid-Price Center Divider */}
        <div className="my-1 flex items-center justify-between rounded-md border hairline bg-[var(--color-ink)] px-2.5 py-1 text-[11px] mono">
          <div className="flex items-center gap-2">
            <span className="text-dim text-[10px]">Mid:</span>
            <span className="text-sm font-bold text-gold">
              {stats?.price !== null && stats?.price !== undefined ? formatPrice(stats.price, tickSize) : "—"}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-dim">
            <span>Spread:</span>
            <span className="text-text font-semibold">
              {spread !== null ? formatPrice(spread, tickSize) : "—"}
            </span>
            {spreadPct !== null && (
              <span className="text-muted">({spreadPct.toFixed(3)}%)</span>
            )}
          </div>
        </div>

        {/* Bids (Buy Side - Green) */}
        <div className="flex flex-col gap-0.5">
          {bids.map(([p, q], i) => {
            const widthPct = Math.min(100, (q / maxQty) * 100);
            return (
              <div
                key={`bid-${p}-${i}`}
                className="relative flex items-center justify-between rounded px-2 py-1 text-[11px] mono transition-colors hover:bg-[rgba(67,196,149,0.08)]"
              >
                {/* Visual Depth Bar */}
                <div
                  className="absolute inset-y-0 end-0 rounded-s opacity-20 pointer-events-none transition-all duration-300"
                  style={{
                    width: `${widthPct}%`,
                    background: "var(--color-up)",
                  }}
                />
                <span className="font-semibold" style={{ color: "var(--color-up)" }}>
                  {formatPrice(p, tickSize)}
                </span>
                <span className="text-text">{q.toFixed(2)}</span>
                <span className="text-dim text-[10px]">{(p * q).toFixed(0)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Loading / Unavailable Overlay if Needed */}
      {obPoll.status !== "OK" && (
        <div className="mt-2 text-center py-4 text-[11px] text-dim border-t hairline">
          {obPoll.status === "LOADING" ? "Loading order book depth…" : "Live order book depth unavailable"}
        </div>
      )}
    </div>
  );
}
