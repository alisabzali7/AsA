"use client";
/**
 * AsA HOME — Living Intelligence Dashboard & Trading Workstation.
 *
 * Visual & functional composition:
 * 1. First-Entry Cinematic Experience (3D Banknote Tear + Persian Welcome Reveal)
 * 2. Dynamic AsA Identity Hero (Living state, light pass, system heartbeat)
 * 3. 3D Dimensional Market Container (10 Primary assets + "+ بیشتر" expansion to full universe)
 * 4. Day Gainers Section (strict 24h positive movers, honest empty state)
 * 5. Dimensional 3D Order Book (Bids, Asks, real-time depth bars, spread)
 * 6. Market Pulse (نبض بازار - BTC, ETH, Gold, Silver, Brent heartbeat with honest availability)
 * 7. Active Opportunities & Signals Stream
 * 8. Quick Grounded AI Assistant Launcher
 * 9. Real-Time Event Bus
 * 10. Advisory Execution Boundary Architecture
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLang } from "@/components/lang";
import { usePoll, useSse, fmtAge, formatPrice } from "@/components/hooks";
import { Badge, Button, Card, Metric, Panel, SectionHeader, Stat, StatusBadge, Timeline } from "@/components/ui";
import { TruthState, StatusWord } from "@/components/data-state";
import {
  topByPrice,
  topGainers,
  effectiveAgeMs,
  displayStateFor,
  healthDisplayState,
  type SystemHealthShape,
} from "@/components/board-selectors";
import { useSelection, useWatchlist } from "@/components/selection";
import { openPalette } from "@/components/chrome";
import { IntroCinematic } from "@/components/intro-cinematic";
import { Market3DBox } from "@/components/market-3d-box";
import { MarketPulse } from "@/components/market-pulse";
import { Orderbook3D } from "@/components/orderbook-3d";
import {
  IconAi,
  IconChart,
  IconLayers,
  IconMarket,
  IconOpportunity,
  IconPinFilled,
  IconPulse,
  IconRefresh,
  IconSearch,
  IconSignal,
  IconSparkles,
  IconTrendingUp,
  IconZap,
} from "@/components/icons";

interface BoardRow {
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  volume24hQuote: number | null;
  state: string;
  age_ms: number | null;
  tick_size: number | null;
}

interface BoardShape {
  ok: boolean;
  rows: BoardRow[];
  stats_age_ms: number | null;
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
  fresh: string;
  entry_zone?: { top: number; bottom: number } | null;
  risk?: { verdict: string } | null;
}

interface SigItem {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  state: string;
  strategy_id: string;
  created_ms: number;
}

const PIPELINE = [
  "LIVE MARKET (TTT)",
  "DATA → HISTORY",
  "MULTI-TF 4H/1H/15M",
  "STRATEGY",
  "PSYCHOLOGY",
  "ANALYSIS",
  "DERIVATIVES (verified)",
  "FUNDAMENTAL/NEWS",
  "OPPORTUNITY → RISK",
  "SIGNAL → CHART",
  "TELEGRAM",
  "HUMAN EXECUTES",
];

export default function DashboardPage() {
  const { lang, t } = useLang();
  const router = useRouter();
  const [sel, setSel] = useSelection();
  const [watchlist] = useWatchlist();

  // Cinematic Intro Controller
  const [showIntro, setShowIntro] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return !sessionStorage.getItem("asa-intro-seen");
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const handleReplay = () => setShowIntro(true);
    window.addEventListener("asa:replay-intro", handleReplay);
    return () => window.removeEventListener("asa:replay-intro", handleReplay);
  }, []);

  const board = usePoll<BoardShape>("/api/market/board", 7000);
  const health = usePoll<SystemHealthShape>("/api/system/health", 10000);
  const oppsPoll = usePoll<{ ok: boolean; items: OppItem[] }>("/api/opportunities?limit=8", 15000);
  const sigsPoll = usePoll<{ ok: boolean; items: SigItem[] }>("/api/signals?limit=8", 15000);

  const [quickPrompt, setQuickPrompt] = useState("");

  const [busEvents, setBusEvents] = useState<{ at: number; text: ReactNode }[]>([]);
  const onEvent = useCallback((e: { type: string; ts: number }) => {
    setBusEvents((xs) => [{ at: e.ts, text: e.type }, ...xs].slice(0, 8));
  }, []);
  const sse = useSse(onEvent);

  const rows = board.data?.rows ?? [];
  const live = rows.filter(
    (r) => r.price !== null && displayStateFor(r.state, effectiveAgeMs(r.age_ms, board.age_ms)) === "LIVE"
  ).length;
  const movers = topByPrice(rows, 6);
  const gainers = topGainers(rows, 5);

  const sweepEff = board.status === "OK" ? effectiveAgeMs(board.data?.stats_age_ms ?? null, board.age_ms) : null;
  const boardReady = board.status === "OK";
  const marketState = health.status === "OK" ? health.data?.market ?? "—" : null;

  const healthChip = !health.data
    ? health.status === "LOADING"
      ? "CONNECTING"
      : health.status
    : healthDisplayState(health.data, health.status !== "OK", health.age_ms);

  const marketLive = boardReady && sweepEff !== null && sweepEff < 30000;
  const terminalHref = sel.symbol ? `/chart?symbol=${sel.symbol}` : "/chart";

  const handleQuickAi = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickPrompt.trim()) return;
    router.push(`/ai-clone?q=${encodeURIComponent(quickPrompt.trim())}`);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* --------------------------- CINEMATIC INTRO OVERLAY --------------------------- */}
      {showIntro && (
        <IntroCinematic onComplete={() => setShowIntro(false)} />
      )}

      {/* --------------------------- HERO: DYNAMIC ASA IDENTITY --------------------------- */}
      <section
        className="card relative overflow-hidden p-4 sm:p-6"
        aria-label="AsA living intelligence hero"
        style={{
          background: "radial-gradient(70% 120% at 50% 0%, rgba(216,188,120,0.1) 0%, rgba(14,17,24,0.95) 70%), var(--color-panel)",
        }}
      >
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            {/* Dynamic Dimensional AsA Monogram */}
            <div className="relative flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-2xl border border-gold-2 bg-[rgba(216,188,120,0.08)] shadow-[0_0_30px_rgba(216,188,120,0.25)]">
              <span className="mono text-2xl sm:text-3xl font-black text-gold">AsA</span>
              <span className="absolute -bottom-1 -end-1 h-3.5 w-3.5 rounded-full border-2 border-[var(--color-obsidian)] bg-[var(--color-up)] shadow-sm" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="eyebrow gold-text">AsA INTELLIGENCE WORKSTATION</span>
                <Badge color="var(--color-gold)">TTT MARKET TRUTH</Badge>
              </div>
              <h1 className="mt-0.5 text-xl sm:text-2xl md:text-3xl font-black tracking-tight text-text">
                {lang === "fa" ? "ایستگاه هوش بازار و تصمیم‌گیری تحلیلی" : "Living Intelligence Dashboard"}
              </h1>
              <p className="mt-1 max-w-[65ch] text-[11.5px] sm:text-[12px] leading-relaxed text-muted">
                {boardReady
                  ? marketLive
                    ? `market sweep is live — ${live}/${rows.length} universe rows active · sweep age ${fmtAge(sweepEff)}`
                    : `board snapshot retained from ${fmtAge(sweepEff)} ago — treated as STALE, not live`
                  : `market feed is ${board.status.toLowerCase()}${
                      board.failure?.server_state ? ` (${board.failure.server_state})` : ""
                    } — authoritative truth only`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 ms-auto">
            <Link href={terminalHref} className="focus-ring btn btn-gold !px-3.5 !py-2 text-xs font-bold shadow-md">
              <IconChart size={14} /> {lang === "fa" ? "ورود به ترمینال" : "Open Terminal"}
            </Link>
            <Link href="/market" className="focus-ring btn !px-3 !py-2 text-xs">
              <IconMarket size={14} /> {lang === "fa" ? "تابلوی بازار" : "Market Board"}
            </Link>
            <Link href="/opportunities" className="focus-ring btn !px-3 !py-2 text-xs">
              <IconOpportunity size={14} /> {lang === "fa" ? "فرصت‌ها" : "Opportunities"}
            </Link>
            <button
              className="focus-ring icon-btn !h-9 !w-9 hover:text-gold"
              onClick={() => setShowIntro(true)}
              title="Replay 3D Intro"
            >
              <IconSparkles size={16} />
            </button>
          </div>
        </div>
      </section>

      {/* --------------------------- GLOBAL KPIS --------------------------- */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rise" style={{ ["--i" as never]: 1 }}>
          <Metric
            label="TTT market"
            value={
              boardReady ? (
                <span style={{ color: marketLive ? "var(--color-up)" : "var(--color-warn)" }}>
                  {marketLive ? "LIVE" : "STALE/DEGRADED"}
                </span>
              ) : (
                <StatusWord status={board.status} failure={board.failure} />
              )
            }
            sub={
              boardReady
                ? `sweep age ${sweepEff !== null ? fmtAge(sweepEff) : "—"} · SSE ${sse.connected ? "on" : "off"}`
                : board.failure?.server_state ?? board.failure?.message ?? "—"
            }
          />
        </div>
        <div className="rise" style={{ ["--i" as never]: 2 }}>
          <Metric
            label="universe active"
            value={boardReady ? `${live}/${rows.length}` : "—"}
            sub={
              boardReady
                ? "dynamic TTT discovered universe"
                : `${t("state", "unavailable").split(" —")[0]} until discovery`
            }
            color="var(--color-gold)"
          />
        </div>
        <div className="rise" style={{ ["--i" as never]: 3 }}>
          <Metric
            label="server health"
            value={
              <span className="inline-flex items-center gap-2">
                <StatusBadge state={healthChip === "OK" ? "CONNECTED" : String(healthChip)} />
                <span className="text-[12px] font-bold uppercase">{marketState ?? health.status}</span>
              </span>
            }
            sub={health.data ? (health.data.reason ? `reason: ${health.data.reason}` : "server health verified") : "checking /api/system/health…"}
          />
        </div>
        <div className="rise" style={{ ["--i" as never]: 4 }}>
          <Metric
            label="execution boundary"
            value={<span className="text-gold">ADVISORY</span>}
            sub="pure intelligence · human executes"
          />
        </div>
      </div>

      {board.status !== "OK" && (
        <div className="rise">
          <TruthState
            status={board.status}
            failure={board.failure}
            onRetry={board.refresh}
            staleAgeMs={board.data ? board.stale_age_ms : null}
            loadingText="requesting authoritative TTT universe snapshot…"
          />
        </div>
      )}

      {/* --------------------------- 3D MARKET CONTAINER (10 PRIMARY ASSETS + MORE EXPANSION) --------------------------- */}
      <div className="rise">
        <Market3DBox />
      </div>

      {/* --------------------------- DAY GAINERS & 3D ORDER BOOK & MARKET PULSE --------------------------- */}
      <div className="grid gap-3 lg:grid-cols-3">
        {/* Day Gainers Section */}
        <div className="card p-3 sm:p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b hairline pb-2">
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-line)] text-gold bg-[var(--color-panel-2)]">
                  <IconTrendingUp size={15} />
                </span>
                <h3 className="text-[13px] font-bold text-text">
                  {lang === "fa" ? "بیشترین رشد ۲۴ ساعته" : "Day Gainers"}
                </h3>
              </div>
              <Badge color="var(--color-up)">24h Positive</Badge>
            </div>

            <ul className="mt-3 space-y-2">
              {boardReady &&
                gainers.map((g) => (
                  <li
                    key={g.symbol}
                    className="flex items-center justify-between rounded-md border border-[var(--color-line)] bg-[var(--color-panel-2)] p-2 transition-colors hover:border-gold-3"
                  >
                    <Link
                      href={`/chart?symbol=${g.symbol}`}
                      onClick={() => setSel({ symbol: g.symbol, returnTo: "/" })}
                      className="flex flex-col min-w-0"
                    >
                      <span className="mono text-xs font-bold text-text truncate">{g.symbol}</span>
                      <span className="mono text-[10px] text-dim">{formatPrice(g.price)}</span>
                    </Link>
                    <span className="mono text-xs font-bold text-end" style={{ color: "var(--color-up)" }}>
                      +{g.change24hPct!.toFixed(2)}%
                    </span>
                  </li>
                ))}
              {boardReady && gainers.length === 0 && (
                <li className="py-8 text-center text-dim text-xs">
                  {lang === "fa"
                    ? "در این snapshot رشد ۲۴ ساعته‌ی مثبتی ثبت نشده است."
                    : "no 24h gainers in this snapshot"}
                </li>
              )}
              {!boardReady && (
                <li className="py-8 text-center text-muted text-xs">
                  <span className="breathe">Loading market gainers…</span>
                </li>
              )}
            </ul>
          </div>

          <div className="border-t hairline pt-2 text-[10px] text-dim flex justify-between">
            <span>Strict positive 24h filter</span>
            <span>Measured values only</span>
          </div>
        </div>

        {/* 3D Dimensional Order Book */}
        <div className="lg:col-span-2">
          <Orderbook3D symbol={sel.symbol || "BTCUSDT"} />
        </div>
      </div>

      {/* --------------------------- MARKET PULSE (HEARTBEAT 24H) --------------------------- */}
      <div className="rise">
        <MarketPulse />
      </div>

      {/* --------------------------- INTELLIGENCE STREAMS & AI LAUNCHER --------------------------- */}
      <div className="grid gap-3 lg:grid-cols-3">
        {/* Opportunities Stream */}
        <div className="card p-3 sm:p-4 lg:col-span-2 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b hairline pb-2">
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-md border border-gold-3 text-gold bg-gold-dim">
                  <IconOpportunity size={15} />
                </span>
                <h3 className="text-[13px] font-bold text-text">
                  {lang === "fa" ? "جریان فرصت‌های شناسایی‌شده" : "Active Intelligence Stream"}
                </h3>
              </div>
              <Link href="/opportunities" className="focus-ring btn !py-0.5 !px-2 text-[10.5px]">
                {lang === "fa" ? "مشاهده همه" : "View All"} →
              </Link>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(oppsPoll.data?.items ?? []).slice(0, 4).map((opp) => (
                <div
                  key={opp.id}
                  className="panel-2 p-2.5 flex flex-col justify-between transition-colors hover:border-gold-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="mono font-bold text-xs text-text">{opp.symbol}</span>
                    <StatusBadge state={opp.state} />
                  </div>
                  <div className="my-1.5 flex items-center gap-1.5 text-[11px]">
                    <Badge color="var(--color-gold)">Score {opp.score}</Badge>
                    <span className="mono text-dim">{opp.timeframe}</span>
                    <span className="mono uppercase font-bold" style={{ color: opp.direction === "long" ? "var(--color-up)" : "var(--color-down)" }}>
                      {opp.direction}
                    </span>
                  </div>
                  {opp.thesis && <p className="text-[10px] text-muted line-clamp-2">{opp.thesis}</p>}
                </div>
              ))}
              {(oppsPoll.data?.items?.length ?? 0) === 0 && (
                <div className="col-span-full py-8 text-center text-dim text-xs">
                  No active opportunities currently stored.
                </div>
              )}
            </div>
          </div>

          <div className="border-t hairline pt-2 text-[10px] text-dim flex justify-between">
            <span>Deterministic strategy ranking</span>
            <span>Decision score, not a probability</span>
          </div>
        </div>

        {/* Quick AI Grounded Assistant & Event Bus */}
        <div className="flex flex-col gap-3">
          {/* Grounded AI Form */}
          <div className="card p-3 sm:p-4">
            <div className="flex items-center gap-2 border-b hairline pb-2 mb-2.5">
              <IconAi size={15} className="text-gold" />
              <h3 className="text-[13px] font-bold text-text">
                {lang === "fa" ? "پرسش از کلون هوش مصنوعی" : "AI Grounded Query"}
              </h3>
            </div>

            <form onSubmit={handleQuickAi} className="flex flex-col gap-2">
              <input
                type="text"
                className="input text-xs"
                placeholder={lang === "fa" ? "مثال: وضعیت BTCUSDT چگونه است؟" : "e.g. What is the state of BTCUSDT?"}
                value={quickPrompt}
                onChange={(e) => setQuickPrompt(e.target.value)}
              />
              <Button variant="gold" type="submit" disabled={!quickPrompt.trim()} className="!py-1 text-xs font-bold">
                <IconAi size={13} /> {lang === "fa" ? "ارسال به کلون هوش مصنوعی" : "Ask Grounded AI"}
              </Button>
            </form>
          </div>

          {/* Real-Time Event Bus */}
          <Panel
            title={lang === "fa" ? "جریان رویدادهای زنده" : "Real-time Event Bus"}
            icon={<IconPulse size={13} />}
            right={
              <StatusBadge
                state={sse.connected ? "CONNECTED" : "DISCONNECTED"}
                label={sse.connected ? "SSE on" : "SSE off"}
              />
            }
          >
            <Timeline items={busEvents} />
          </Panel>
        </div>
      </div>

      {/* --------------------------- ADVISORY PIPELINE ARCHITECTURE --------------------------- */}
      <div className="rise">
        <SectionHeader
          label={lang === "fa" ? "معماری خط لوله تصمیم‌گیری AsA" : "AsA Advisory Pipeline (Deterministic Execution Boundary)"}
          icon={<IconZap size={12} />}
        />
        <div className="panel overflow-x-auto px-3 py-2.5">
          <ol className="flex min-w-max items-center gap-0" aria-label="advisory pipeline stages">
            {PIPELINE.map((s, i) => (
              <li key={s} className="flex items-center">
                <span
                  className={`panel-2 rounded-md px-2.5 py-1 text-[9.5px] font-semibold tracking-wide ${
                    i === PIPELINE.length - 1 ? "gold-text border-gold-3" : "text-muted"
                  }`}
                >
                  {s}
                </span>
                {i < PIPELINE.length - 1 && (
                  <span className="px-1.5 text-dim font-bold text-[10px]" aria-hidden="true">
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
