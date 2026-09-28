"use client";
/**
 * Market Inspector Drawer — deep contextual inspection for any discovered symbol.
 * Consumes real TTT endpoints: /api/market/stats, /api/market/orderbook, /api/market/trades,
 * /api/opportunities, /api/signals.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AdaptiveDrawer } from "./overlay";
import { Badge, Button, Metric, ProvenanceBadge, Stat, StatusBadge, Tabs } from "./ui";
import { formatPrice, fmtAge, usePoll } from "./hooks";
import { useSelection, useWatchlist } from "./selection";
import { IconAi, IconChart, IconPin, IconPinFilled } from "./icons";
import { TruthState } from "./data-state";

interface StatsShape {
  ok: boolean;
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24hQuote: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  age_ms: number | null;
  state: string;
  tick_size: number | null;
}

interface OrderbookShape {
  ok: boolean;
  symbol: string;
  bids: [number, number][]; // [price, size]
  asks: [number, number][];
  ts: number;
}

interface TradeShape {
  id: string | number;
  price: number;
  size: number;
  side: "buy" | "sell" | "unknown";
  ts: number;
}
interface TradesShape {
  ok: boolean;
  symbol: string;
  trades: TradeShape[];
}

interface OppItem {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  strategy_id: string;
  state: string;
  thesis?: string;
  entry_zone?: { top: number; bottom: number } | null;
  stop?: number | null;
  targets?: number[];
  risk?: { verdict: string; reasons: string[] } | null;
}

interface SigItem {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  state: string;
  strategy_id: string;
}

export function MarketInspectorDrawer({
  symbol,
  onClose,
}: {
  symbol: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [, setSel] = useSelection();
  const [watchlist, toggleWatchlist] = useWatchlist();
  const [tab, setTab] = useState<"overview" | "orderbook" | "trades" | "intelligence">("overview");

  const statsPoll = usePoll<StatsShape>(symbol ? `/api/market/stats?symbol=${symbol}` : null, 6000);
  const obPoll = usePoll<OrderbookShape>(symbol && tab === "orderbook" ? `/api/market/orderbook?symbol=${symbol}` : null, 4000);
  const tradesPoll = usePoll<TradesShape>(symbol && tab === "trades" ? `/api/market/trades?symbol=${symbol}` : null, 4000);
  const oppsPoll = usePoll<{ ok: boolean; items: OppItem[] }>(symbol ? `/api/opportunities?symbol=${symbol}&limit=10` : null, 15000);
  const sigsPoll = usePoll<{ ok: boolean; items: SigItem[] }>(symbol ? `/api/signals?symbol=${symbol}&limit=10` : null, 15000);

  const stats = statsPoll.data;
  const isPinned = symbol ? watchlist.includes(symbol) : false;

  const symbolOpps = useMemo(() => {
    return (oppsPoll.data?.items ?? []).filter((o) => o.symbol === symbol);
  }, [oppsPoll.data, symbol]);

  const symbolSigs = useMemo(() => {
    return (sigsPoll.data?.items ?? []).filter((s) => s.symbol === symbol);
  }, [sigsPoll.data, symbol]);

  if (!symbol) return null;

  const price = stats?.price;
  const change = stats?.change24hPct;
  const isUp = change != null ? change >= 0 : null;
  const high = stats?.high24h;
  const low = stats?.low24h;

  // 24h range percentage
  const rangeProgress =
    high != null && low != null && price != null && high > low
      ? Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100))
      : 50;

  const handleOpenChart = () => {
    setSel({ symbol, returnTo: "/market" });
    onClose();
    router.push(`/chart?symbol=${symbol}`);
  };

  const handleOpenAi = () => {
    setSel({ symbol, returnTo: "/market" });
    onClose();
    router.push(`/ai-clone?q=${encodeURIComponent(`What is the current technical and risk state of ${symbol}?`)}`);
  };

  return (
    <AdaptiveDrawer
      title={symbol}
      sub="TTT market truth · real-time inspector"
      onClose={onClose}
      width="540px"
      badge={
        <div className="flex items-center gap-1.5">
          {stats?.state && <StatusBadge state={stats.state} />}
          <button
            onClick={() => toggleWatchlist(symbol)}
            className="focus-ring icon-btn !h-6 !w-6 text-muted hover:text-gold"
            title={isPinned ? "remove from watchlist" : "pin to watchlist"}
            aria-pressed={isPinned}
          >
            {isPinned ? <IconPinFilled size={13} className="text-gold" /> : <IconPin size={13} />}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Quick action bar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b hairline pb-3">
          <Button variant="gold" className="flex-1 !py-1 text-[11px]" onClick={handleOpenChart}>
            <IconChart size={13} /> Open on Terminal
          </Button>
          <Button variant="default" className="flex-1 !py-1 text-[11px]" onClick={handleOpenAi}>
            <IconAi size={13} /> Ask AI Clone
          </Button>
        </div>

        {/* Hero Price & 24h stats */}
        <div className="panel-2 p-3">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="eyebrow text-dim">last price</div>
              <div className="mono text-2xl font-bold tracking-tight" style={{ color: isUp ? "var(--color-up)" : isUp === false ? "var(--color-down)" : "inherit" }}>
                {formatPrice(price, stats?.tick_size)}
              </div>
            </div>
            <div className="text-end">
              <div className="eyebrow text-dim">24h change</div>
              <div className="mono text-base font-semibold" style={{ color: isUp ? "var(--color-up)" : isUp === false ? "var(--color-down)" : "var(--color-muted)" }}>
                {change != null ? `${isUp ? "+" : ""}${change.toFixed(2)}%` : "—"}
              </div>
            </div>
          </div>

          {/* 24h Range Bar */}
          {high != null && low != null && (
            <div className="mt-3">
              <div className="flex justify-between text-[9.5px] text-muted mono">
                <span>L: {formatPrice(low, stats?.tick_size)}</span>
                <span className="text-dim">24h Range</span>
                <span>H: {formatPrice(high, stats?.tick_size)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line-2)]">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${rangeProgress}%`,
                    background: "linear-gradient(90deg, var(--color-down), var(--color-gold), var(--color-up))",
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Tabs for detailed sections */}
        <Tabs
          label="Inspector view tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "orderbook", label: "Orderbook" },
            { id: "trades", label: "Trades" },
            { id: "intelligence", label: `Intelligence (${symbolOpps.length + symbolSigs.length})` },
          ]}
        />

        {/* Overview tab */}
        {tab === "overview" && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-1.5">
              <Stat k="vol 24h (quote)" v={stats?.volume24hQuote != null ? `$${(stats.volume24hQuote / 1e6).toFixed(2)}M` : "—"} />
              <Stat k="funding rate" v={stats?.fundingRate != null ? `${(stats.fundingRate * 100).toFixed(4)}%` : "—"} color={stats?.fundingRate && Math.abs(stats.fundingRate) > 0.0001 ? "var(--color-warn)" : undefined} />
              <Stat k="open interest" v={stats?.openInterest != null ? stats.openInterest.toLocaleString() : "—"} />
              <Stat k="tick size" v={stats?.tick_size != null ? String(stats.tick_size) : "—"} />
            </div>

            <div className="panel-2 p-2.5 text-[11px] space-y-1.5">
              <div className="eyebrow text-gold">Advisory Truth Constraints</div>
              <p className="text-muted leading-relaxed">
                AsA reads raw TTT market data without client-side calculation of prices. Execution is manual and advisory only. Liquidations, long/short ratios, and CVD are permanently UNAVAILABLE on public endpoints.
              </p>
              <ProvenanceBadge source="TTT /futures/markets/stats" endpoint="/api/market/stats" kind="MARKET_SWEEP" />
            </div>
          </div>
        )}

        {/* Orderbook tab */}
        {tab === "orderbook" && (
          <div className="flex flex-col gap-2">
            {obPoll.status !== "OK" ? (
              <TruthState status={obPoll.status} failure={obPoll.failure} onRetry={obPoll.refresh} loadingText="loading live orderbook…" />
            ) : (
              <div className="panel-2 p-2">
                <div className="flex justify-between text-[10px] text-muted pb-1 border-b hairline">
                  <span>Price (USD)</span>
                  <span>Size ({symbol.replace("USDT", "")})</span>
                </div>
                {/* Asks (Red) */}
                <div className="space-y-0.5 py-1">
                  {(obPoll.data?.asks ?? []).slice(-8).reverse().map(([p, s], i) => (
                    <div key={i} className="flex justify-between text-[11px] mono">
                      <span style={{ color: "var(--color-down)" }}>{formatPrice(p, stats?.tick_size)}</span>
                      <span className="text-dim">{s.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
                {/* Spread */}
                <div className="my-1 py-1 border-y hairline text-center text-[10px] text-gold mono">
                  Spread: {price != null ? formatPrice(price, stats?.tick_size) : "—"}
                </div>
                {/* Bids (Green) */}
                <div className="space-y-0.5 py-1">
                  {(obPoll.data?.bids ?? []).slice(0, 8).map(([p, s], i) => (
                    <div key={i} className="flex justify-between text-[11px] mono">
                      <span style={{ color: "var(--color-up)" }}>{formatPrice(p, stats?.tick_size)}</span>
                      <span className="text-dim">{s.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Trades tab */}
        {tab === "trades" && (
          <div className="flex flex-col gap-2">
            {tradesPoll.status !== "OK" ? (
              <TruthState status={tradesPoll.status} failure={tradesPoll.failure} onRetry={tradesPoll.refresh} loadingText="loading recent trades…" />
            ) : (
              <div className="panel-2 p-2">
                <div className="flex justify-between text-[10px] text-muted pb-1 border-b hairline">
                  <span>Price</span>
                  <span>Size</span>
                  <span>Time</span>
                </div>
                <div className="space-y-1 py-1 max-h-[320px] overflow-y-auto">
                  {(tradesPoll.data?.trades ?? []).slice(0, 30).map((tr, i) => (
                    <div key={tr.id ?? i} className="flex justify-between text-[11px] mono">
                      <span style={{ color: tr.side === "buy" ? "var(--color-up)" : tr.side === "sell" ? "var(--color-down)" : "inherit" }}>
                        {formatPrice(tr.price, stats?.tick_size)}
                      </span>
                      <span className="text-dim">{tr.size.toFixed(3)}</span>
                      <span className="text-dim text-[10px]">
                        {new Date(tr.ts).toLocaleTimeString("en-GB", { hour12: false })}
                      </span>
                    </div>
                  ))}
                  {(tradesPoll.data?.trades?.length ?? 0) === 0 && (
                    <div className="text-center py-4 text-[11px] text-dim">No trades in window</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Intelligence tab */}
        {tab === "intelligence" && (
          <div className="flex flex-col gap-2">
            <div className="eyebrow text-gold">Stored Opportunities ({symbolOpps.length})</div>
            {symbolOpps.map((opp) => (
              <div key={opp.id} className="panel-2 p-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{opp.timeframe} · {opp.direction}</span>
                  <StatusBadge state={opp.state} />
                </div>
                <div className="mt-1 flex gap-1">
                  <Badge color="var(--color-gold)">Score {opp.score}</Badge>
                  <Badge>{opp.strategy_id}</Badge>
                </div>
                {opp.thesis && <p className="mt-1 text-muted text-[10.5px]">{opp.thesis}</p>}
              </div>
            ))}
            {symbolOpps.length === 0 && <p className="text-[11px] text-dim">No active opportunities stored for {symbol}.</p>}

            <div className="eyebrow text-gold mt-2">Stored Signals ({symbolSigs.length})</div>
            {symbolSigs.map((sig) => (
              <div key={sig.id} className="panel-2 p-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{sig.timeframe} · {sig.direction}</span>
                  <StatusBadge state={sig.state} />
                </div>
                <div className="mt-1 flex gap-1">
                  <Badge color="var(--color-gold)">Score {sig.score}</Badge>
                  <Badge>{sig.strategy_id}</Badge>
                </div>
              </div>
            ))}
            {symbolSigs.length === 0 && <p className="text-[11px] text-dim">No signals stored for {symbol}.</p>}
          </div>
        )}
      </div>
    </AdaptiveDrawer>
  );
}
