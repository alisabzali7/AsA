"use client";
/** Command Center — the operator's front door, not a landing page.
 *  Priority order: current state → what changed → what needs review →
 *  primary actions. Every metric renders the provider's normalized state
 *  (LOADING/READY/UNAVAILABLE/ERROR/OFFLINE) — never a fabricated zero,
 *  never "empty" when the server actually said unavailable. */
import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { useLang } from "@/components/lang";
import { usePoll, useSse, fmtAge, formatPrice } from "@/components/hooks";
import { Metric, Panel, StatusBadge, SectionHeader, Timeline } from "@/components/ui";
import { TruthState, StatusWord } from "@/components/data-state";
import { topByPrice, topGainers, effectiveAgeMs, displayStateFor, healthDisplayState, type SystemHealthShape } from "@/components/board-selectors";
import { useSelection } from "@/components/selection";
import { openPalette } from "@/components/chrome";
import { IconChart, IconMarket, IconPulse, IconSearch, IconZap } from "@/components/icons";

interface BoardRow { symbol: string; price: number | null; change24hPct: number | null; state: string; age_ms: number | null }
interface BoardShape { ok: boolean; rows: BoardRow[]; stats_age_ms: number | null }

const PIPELINE = ["LIVE MARKET (TTT)", "DATA → HISTORY", "MULTI-TF 4H/1H/15M", "STRATEGY", "PSYCHOLOGY", "ANALYSIS", "DERIVATIVES (verified)", "FUNDAMENTAL/NEWS", "OPPORTUNITY → RISK", "SIGNAL → CHART", "TELEGRAM", "HUMAN EXECUTES"];

export default function DashboardPage() {
  const { t } = useLang();
  const board = usePoll<BoardShape>("/api/market/board", 7000);
  // health endpoint contract — one shape shared with board-selectors so the
// chip and its display helper can never drift apart
const health = usePoll<SystemHealthShape>("/api/system/health", 10000);
  const [busEvents, setBusEvents] = useState<{ at: number; text: ReactNode }[]>([]);
  const onEvent = useCallback((e: { type: string; ts: number }) => {
    setBusEvents((xs) => [{ at: e.ts, text: e.type }, ...xs].slice(0, 8));
  }, []);
  const sse = useSse(onEvent);
  const [sel] = useSelection();
  const rows = board.data?.rows ?? [];
  const live = rows.filter((r) => r.price !== null).length;
  const movers = topByPrice(rows, 7);
  const gainers = topGainers(rows, 5);
  // Effective sweep age (server age + time since this snapshot arrived): the
  // "LIVE" verdict must re-derive from the ELAPSED age, else a cached board
  // would keep reading LIVE forever while the connection is down.
  const sweepEff = board.status === "OK" ? effectiveAgeMs(board.data?.stats_age_ms ?? null, board.age_ms) : null;
  const boardReady = board.status === "OK";
  const marketState = health.status === "OK" ? health.data?.market ?? "—" : null;
  // TRUTH FIX (merged from Team-02): the chip renders the HEALTH ENDPOINT's
  // own market state with age decay — never socket connectivity, never the
  // bare presence of a payload
  const healthChip = !health.data
    ? health.status === "LOADING" ? "CONNECTING" : health.status
    : healthDisplayState(health.data, health.status !== "OK", health.age_ms);
  const marketLive = boardReady && sweepEff !== null && sweepEff < 30000;
  const terminalHref = sel.symbol ? `/chart?symbol=${sel.symbol}` : "/chart";

  return (
    <div className="flex flex-col gap-2.5">
      {/* ------------------------------------------------------ hero band */}
      <section className="rise card relative overflow-hidden px-4 py-5 sm:px-6" aria-label="AsA status header">
        <div className="pointer-events-none absolute inset-x-0 -top-32 h-56" style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(216,188,120,0.10), transparent 70%)" }} aria-hidden />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Advisory intelligence terminal · market truth: TTT only</p>
            <h1 className="mt-1 flex flex-wrap items-baseline gap-x-3 text-2xl font-bold tracking-tight sm:text-[28px]">
              <span className="gold-text tracking-[0.14em]">ASA</span>
              <span className="text-[11px] font-normal text-muted" dir="auto">advisory only — you execute</span>
            </h1>
            <p className="mt-1.5 max-w-[62ch] text-[12px] leading-relaxed text-muted">
              {boardReady
                ? marketLive
                  ? `market sweep is live — ${live}/${rows.length} universe rows priced · sweep age ${fmtAge(sweepEff)}`
                  : `board snapshot retained from ${fmtAge(sweepEff)} ago — treated as STALE, not live`
                : `market feed is ${board.status.toLowerCase()}${board.failure?.server_state ? ` (${board.failure.server_state})` : ""} — the terminal shows the provider's verdict, never a substitute`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={terminalHref} className="focus-ring btn btn-gold !px-3 !py-1.5 text-[11.5px]">
              <IconChart size={13} /> Open terminal
            </Link>
            <Link href="/market" className="focus-ring btn !px-3 !py-1.5 text-[11.5px]">
              <IconMarket size={13} /> Market board
            </Link>
            <button className="focus-ring btn !px-3 !py-1.5 text-[11.5px]" onClick={openPalette} aria-keyshortcuts="Meta+K Control+K">
              <IconSearch size={13} /> <span className="mono text-[9px] text-dim">⌘K</span>
            </button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ KPIs */}
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
                ? `last sweep ${sweepEff !== null ? fmtAge(sweepEff) : "—"} · SSE ${sse.connected ? "on" : "off"}`
                : board.failure?.server_state ?? board.failure?.message ?? "—"
            }
          />
        </div>
        <div className="rise" style={{ ["--i" as never]: 2 }}>
          <Metric
            label="universe live"
            value={boardReady ? `${live}/${rows.length}` : "—"}
            sub={boardReady ? "TTT /futures/markets/stats — one request per sweep" : `${t("state", "unavailable").split(" —")[0]} until TTT discovery succeeds`}
            color="var(--color-gold)"
          />
        </div>
        <div className="rise" style={{ ["--i" as never]: 3 }}>
          <Metric
            label="server health"
            value={
              <span className="inline-flex items-center gap-2">
                <StatusBadge state={healthChip === "OK" ? "CONNECTED" : String(healthChip)} />
                {marketState !== null && <span className="mono text-[11px] text-muted">{marketState}</span>}
              </span>
            }
            sub={health.status === "OK" ? `/api/system/health · ${health.data?.reason ?? ""}` : "health endpoint not answering"}
          />
        </div>
        <div className="rise" style={{ ["--i" as never]: 4 }}>
          <Metric label="mode" value="ADVISORY" sub="AsA never executes — human executes" color="var(--color-muted)" />
        </div>
      </div>

      {!boardReady && (
        <TruthState status={board.status} failure={board.failure} onRetry={board.refresh} staleAgeMs={board.data ? board.stale_age_ms : null} />
      )}

      {/* ---------------------------------------------------- working grid */}
      <div className="grid gap-2 lg:grid-cols-[1fr_330px]">
        <div className="rise" style={{ ["--i" as never]: 5 }}>
          <Panel
            title="market snapshot — top by price"
            icon={<IconMarket size={12} />}
            right={<Link href="/market" className="focus-ring btn !py-0.5 !px-2 text-[10px]">full board <IconZap size={10} /></Link>}
          >
            <div className="overflow-x-auto">
              <table className="tbl w-full">
                <caption className="sr-only">Top TTT universe rows by measured last price, shown when READY, absent otherwise</caption>
                <thead><tr><th scope="col">{t("market", "symbol")}</th><th scope="col" className="text-end">Price</th><th scope="col" className="text-end">24h</th><th scope="col">State</th></tr></thead>
                <tbody>
                  {boardReady && movers.map((r) => (
                    <tr key={r.symbol}>
                      <td><Link className="focus-ring rounded px-1 font-semibold hover:text-gold" href={`/chart?symbol=${r.symbol}`}>{r.symbol}</Link></td>
                      <td className="mono text-end">{formatPrice(r.price)}</td>
                      <td className="mono text-end" style={{ color: r.change24hPct === null ? "var(--color-muted)" : r.change24hPct >= 0 ? "var(--color-up)" : "var(--color-down)" }}>{r.change24hPct === null ? "—" : `${r.change24hPct.toFixed(2)}%`}</td>
                      <td><StatusBadge state={displayStateFor(r.state, effectiveAgeMs(r.age_ms, board.age_ms))} /></td>
                    </tr>
                  ))}
                  {board.status === "LOADING" && <tr><td colSpan={4} className="py-6 text-center text-muted">{t("state", "loading")}</td></tr>}
                  {(!boardReady && board.status !== "LOADING") && (
                    <tr><td colSpan={4} className="py-6 text-center text-muted">no board to show — {board.failure?.server_state ? `server reports ${board.failure.server_state}` : "the provider has not received an answer"}</td></tr>
                  )}
                  {boardReady && movers.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">universe answered with no priced rows yet</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-2">
          <div className="rise" style={{ ["--i" as never]: 6 }}>
            <Panel title="day gainers">
              <ul className="space-y-1 text-[11.5px]">
                {boardReady && gainers.map((g) => (
                  <li key={g.symbol} className="flex justify-between">
                    <Link href={`/chart?symbol=${g.symbol}`} className="focus-ring rounded font-medium hover:text-gold px-0.5">{g.symbol}</Link>
                    <span className="mono" style={{ color: "var(--color-up)" }}>+{g.change24hPct!.toFixed(2)}%</span>
                  </li>
                ))}
                {!boardReady && <li className="text-muted">waiting for a READY board snapshot — an unavailable universe has no gainers</li>}
                {boardReady && rows.length === 0 && <li className="text-muted">universe is empty until discovery completes</li>}
                {boardReady && rows.length > 0 && gainers.length === 0 && (
                  <li className="text-muted">no 24h gainers in this snapshot — losing rows are not gainers</li>
                )}
              </ul>
            </Panel>
          </div>
          <div className="rise" style={{ ["--i" as never]: 7 }}>
            <Panel
              title="event bus"
              icon={<IconPulse size={12} />}
              right={<StatusBadge state={sse.connected ? "CONNECTED" : "DISCONNECTED"} label={sse.connected ? "SSE socket on" : "SSE socket off"} />}
            >
              <Timeline items={busEvents} />
            </Panel>
          </div>
          {sel.symbol && (
            <div className="rise" style={{ ["--i" as never]: 8 }}>
              <Panel title="continue">
                <p className="text-[11px] leading-relaxed text-muted">
                  last selected <Link className="mono text-gold hover:underline" href={`/chart?symbol=${sel.symbol}`}>{sel.symbol}</Link>
                  {sel.tf ? <> · timeframe <span className="mono">{sel.tf}</span></> : null}
                </p>
              </Panel>
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------------- pipeline chain */}
      <div className="rise" style={{ ["--i" as never]: 9 }}>
        <SectionHeader label="architecture — advisory pipeline (map, not a status board)" icon={<IconZap size={12} />} />
        <div className="panel overflow-x-auto px-3 py-2.5">
          <ol className="flex min-w-max items-center gap-0" aria-label="advisory pipeline stages">
            {PIPELINE.map((s, i) => (
              <li key={s} className="flex items-center">
                <span className={`panel-2 rounded-md px-2.5 py-1 text-[9.5px] font-semibold tracking-wide ${i === PIPELINE.length - 1 ? "text-gold" : "text-muted"}`} style={i === PIPELINE.length - 1 ? { borderColor: "var(--color-gold-3)" } : undefined}>
                  <span className="mono me-1 text-dim">{String(i + 1).padStart(2, "0")}</span>{s}
                </span>
                {i < PIPELINE.length - 1 && (
                  <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden className="mx-0.5 shrink-0 text-line-2 rtl:-scale-x-100">
                    <path d="M0 4h18m0 0l-3-3m3 3l-3 3" stroke="currentColor" strokeWidth="1.2" fill="none" />
                    <circle cx="23" cy="4" r="1.4" fill="currentColor" />
                  </svg>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="text-center text-[10px] text-dim">
        TTT is the only production market-data source · every value carries provenance · missing = UNAVAILABLE with reason
      </div>
    </div>
  );
}
