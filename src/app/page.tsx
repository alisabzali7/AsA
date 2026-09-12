"use client";
/** Command Center — health, live board summary, MTF focus, events. */
import Link from "next/link";
import { useLang } from "@/components/lang";
import { usePoll, useSse, fmtAge } from "@/components/hooks";
import { Metric, Panel, StatusChip } from "@/components/ui";

interface BoardRow { symbol: string; price: number | null; change24hPct: number | null; state: string; age_ms: number | null }
interface BoardShape { ok: boolean; rows: BoardRow[]; stats_age_ms: number | null }

export default function DashboardPage() {
  const { t } = useLang();
  const board = usePoll<BoardShape>("/api/market/board", 7000);
  const sse = useSse();
  const rows = board.data?.rows ?? [];
  const live = rows.filter((r) => r.price !== null).length;
  const movers = [...rows].filter((r) => r.price !== null).sort((a, b) => (b.price ?? 0) - (a.price ?? 0)).slice(0, 8);
  const gainers = [...rows].sort((a, b) => (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity)).slice(0, 5);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="TTT market" value={<span style={{ color: sse.connected ? "#3fb68b" : "#d6a24a" }}>{board.data?.stats_age_ms !== null && board.data?.stats_age_ms !== undefined && board.data.stats_age_ms < 30000 ? "LIVE" : "CONNECTING/STALE"}</span>} sub={`last sweep ${board.data?.stats_age_ms !== null && board.data?.stats_age_ms !== undefined ? fmtAge(board.data.stats_age_ms) : "—"} · SSE ${sse.connected ? "on" : "off"}`} />
        <Metric label="universe live" value={`${live}/48`} sub="TTT /futures/markets/stats — one request per sweep" color="#d4b874" />
        <Metric label="health endpoint" value={<StatusChip state={sse.connected ? "LIVE" : "CONNECTING"} />} sub="/api/system/health" />
        <Metric label="mode" value="ADVISORY" sub="AsA never executes — human executes" color="#8b8f99" />
      </div>

      <div className="grid gap-2 lg:grid-cols-[1fr_340px]">
        <Panel title="live board — top by market cap">
          <div className="overflow-x-auto">
            <table className="tbl w-full">
              <thead><tr><th>{t("market", "symbol")}</th><th className="text-right">{t("market", "price")}</th><th className="text-right">24h</th><th>state</th></tr></thead>
              <tbody>
                {movers.map((r) => (
                  <tr key={r.symbol}>
                    <td><Link className="focus-ring rounded px-1 font-semibold hover:text-gold" href={`/chart?symbol=${r.symbol}`}>{r.symbol}</Link></td>
                    <td className="mono text-right">{r.price === null ? "—" : r.price.toLocaleString("en-US", { maximumFractionDigits: r.price < 1 ? 6 : 2 })}</td>
                    <td className="mono text-right" style={{ color: r.change24hPct === null ? "var(--color-muted)" : r.change24hPct >= 0 ? "#3fb68b" : "#d9605e" }}>{r.change24hPct === null ? "—" : `${r.change24hPct.toFixed(2)}%`}</td>
                    <td><StatusChip state={r.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="flex flex-col gap-2">
          <Panel title="day gainers">
            <ul className="space-y-1 text-[11.5px]">
              {gainers.map((g) => (
                <li key={g.symbol} className="flex justify-between">
                  <span className="font-medium">{g.symbol}</span>
                  <span className="mono" style={{ color: (g.change24hPct ?? 0) >= 0 ? "#3fb68b" : "#d9605e" }}>
                    {(g.change24hPct ?? 0) >= 0 ? "+" : ""}{(g.change24hPct ?? 0).toFixed(2)}%
                  </span>
                </li>
              ))}
              {rows.length === 0 && <li className="text-muted">waiting for first TTT snapshot…</li>}
            </ul>
          </Panel>
          <Panel title="pipeline">
            <ol className="space-y-0.5 text-[10.5px] leading-relaxed text-muted">
              {["LIVE MARKET (TTT)", "DATA → HISTORY", "MULTI-TF 4H/1H/15M", "STRATEGY", "PSYCHOLOGY", "ANALYSIS", "DERIVATIVES (verified)", "FUNDAMENTAL/NEWS", "OPPORTUNITY → RISK", "SIGNAL → CHART", "TELEGRAM", "HUMAN EXECUTES"].map((s, i) => (
                <li key={s} className="flex gap-1.5"><span className="text-gold-dim">{String(i + 1).padStart(2, "0")}</span><span className={i === 11 ? "text-gold" : undefined}>{s}</span></li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
      <div className="text-center text-[10px] text-dim">
        TTT is the only production market-data source · every value carries provenance · missing = UNAVAILABLE with reason
      </div>
    </div>
  );
}
