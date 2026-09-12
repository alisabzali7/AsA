"use client";
/**
 * Backtest — deterministic runs over real TTT candles, full lineage.
 *
 * AUDIT FIX (P1): the page used to POST the removed `reference-trend-continuation`
 * strategy id (every run 400-ed) and read the OLD result shape (`stats.trades`,
 * `entry_time`, `pnl_pct`) that the unified strategy runner no longer emits.
 * It now targets the real Brain runtime strategies and the actual contract:
 * `result.metrics` + `result.positions` (absolute timestamps, R multiples,
 * quote pnl), plus the data-freshness statement.
 */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Badge, Empty, Panel } from "@/components/ui";

interface StrategyList {
  strategies: { id: string; name: string; status: string; version: string; executable: boolean; timeframe: string; direction: string }[];
}
interface DataFreshnessInfo {
  fresh_sync_status: string;
  fresh_sync_error: string | null;
  last_successful_sync_ms: number | null;
  used_stored_data_after_failed_sync: boolean;
}
interface BTResult {
  ok: boolean; jobId: string; status: string;
  data_freshness?: DataFreshnessInfo;
  result?: {
    ok: boolean; error?: string; lineage: unknown; warnings: string[];
    metrics: {
      trade_count: number; wins: number; losses: number; win_rate: number | null;
      average_r: number | null; expectancy_r: number | null; total_r: number;
      profit_factor: number | null; max_drawdown_r: number; max_drawdown_pct: number | null;
      longest_loss_streak: number; return_pct: number | null; sufficient_sample: boolean;
    };
    positions: {
      direction: string; signal_ts: number; entry_ts: number; exit_ts: number;
      entry_price: number; avg_exit_price: number; r_multiple: number; pnl_quote: number;
      outcome: string; bars_held: number; score: number;
    }[];
  };
}
interface SymList { symbols: string[] }

export default function BacktestPage() {
  const { t } = useLang();
  const strats = usePoll<StrategyList>("/api/research/strategies", 120_000);
  const syms = usePoll<SymList>("/api/market/symbols", 600_000);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [fee, setFee] = useState(0.08);
  const [slip, setSlip] = useState(0.02);
  const [policy, setPolicy] = useState<"stop_first" | "target_first">("stop_first");
  const [days, setDays] = useState(180);
  const [strategyId, setStrategyId] = useState<string>("");
  const [job, setJob] = useState<BTResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const executable = (strats.data?.strategies ?? []).filter((s) => s.executable);
  const chosen = strategyId || executable[0]?.id || "";

  const run = async () => {
    if (!chosen) { setErr("no executable strategy available"); return; }
    setBusy(true); setErr(null); setJob(null);
    try {
      const res = await fetch("/api/research/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId: chosen, symbol, sameBarPolicy: policy, feeRoundTripPct: fee, slippagePct: slip, days }),
      });
      const j = (await res.json()) as BTResult & { error?: string };
      if (!res.ok || j.error) { setErr(j.error ?? `HTTP ${res.status}`); return; }
      setJob(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const r = job?.result;
  const fresh = job?.data_freshness;
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">{t("nav", "backtest")}</h1>
      <Panel title="run a deterministic backtest">
        <div className="flex flex-wrap items-end gap-2 text-[11px]">
          <label className="flex flex-col gap-1"><span className="eyebrow">strategy</span>
            <select className="input w-[220px]" value={chosen} onChange={(e) => setStrategyId(e.target.value)}>
              {executable.length === 0 && <option value="">no executable strategy</option>}
              {executable.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.timeframe} · {s.direction}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1"><span className="eyebrow">symbol</span>
            <select className="input w-[120px]" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(syms.data?.symbols ?? []).slice(0, 30).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1"><span className="eyebrow">days</span><input className="input w-[70px]" type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
          <label className="flex flex-col gap-1"><span className="eyebrow">fee % (round trip)</span><input className="input w-[80px]" type="number" step="0.01" value={fee} onChange={(e) => setFee(Number(e.target.value))} /></label>
          <label className="flex flex-col gap-1"><span className="eyebrow">slippage %</span><input className="input w-[80px]" type="number" step="0.005" value={slip} onChange={(e) => setSlip(Number(e.target.value))} /></label>
          <label className="flex flex-col gap-1"><span className="eyebrow">same-bar policy</span>
            <select className="input w-[130px]" value={policy} onChange={(e) => setPolicy(e.target.value === "target_first" ? "target_first" : "stop_first")}>
              <option value="stop_first">STOP first (conservative)</option>
              <option value="target_first">target first (optimistic)</option>
            </select>
          </label>
          <button className="btn-gold btn" disabled={busy} onClick={() => void run()}>{busy ? "running…" : "run"}</button>
        </div>
        <p className="mt-2 text-[10px] text-dim">
          Strategy evaluated on CLOSED bars of its OWN timeframe · entry at next open ± slippage · same-bar ambiguity policy is explicit and recorded in lineage · funding NOT modelled (flagged) · no result here is a profit guarantee.
        </p>
      </Panel>
      {err && <div className="text-[11px]" style={{ color: "#d9605e" }}>{err}</div>}
      {job?.status === "error" && <Empty text={r?.error ?? "backtest errored"} />}
      {r?.ok && (
        <>
          {fresh && (
            <Panel title="data freshness (honesty statement)">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Badge color={fresh.fresh_sync_status === "failed" ? "#d9605e" : "#3fb68b"}>{`fresh sync: ${fresh.fresh_sync_status}`}</Badge>
                {fresh.used_stored_data_after_failed_sync && <span style={{ color: "#d9605e" }}>ran on PREVIOUSLY STORED TTT data after a failed fresh sync</span>}
                <span className="text-dim">
                  last successful sync: {fresh.last_successful_sync_ms ? new Date(fresh.last_successful_sync_ms).toISOString() : "never"}
                </span>
              </div>
            </Panel>
          )}
          <Panel title="result stats">
            <div className="grid grid-cols-3 gap-1.5 text-center sm:grid-cols-6">
              <StatBox l="trades" v={r.metrics.trade_count} />
              <StatBox l="win rate" v={r.metrics.win_rate === null ? "—" : `${r.metrics.win_rate.toFixed(1)}%`} />
              <StatBox l="expectancy R" v={r.metrics.expectancy_r === null ? "—" : r.metrics.expectancy_r} color={(r.metrics.expectancy_r ?? 0) >= 0 ? "#3fb68b" : "#d9605e"} />
              <StatBox l="profit factor" v={r.metrics.profit_factor === null ? "—" : r.metrics.profit_factor} />
              <StatBox l="max DD % (equity)" v={r.metrics.max_drawdown_pct === null ? "—" : `-${r.metrics.max_drawdown_pct}`} color="#d9605e" />
              <StatBox l="return % (of equity)" v={r.metrics.return_pct === null ? "—" : r.metrics.return_pct} color={(r.metrics.return_pct ?? 0) >= 0 ? "#3fb68b" : "#d9605e"} />
            </div>
            <p className="mt-1 text-[10px] text-dim">
              sample sufficiency (≥30 positions): {r.metrics.sufficient_sample ? "yes" : "NO — treat as anecdote"} · win rate {r.metrics.wins}/{r.metrics.trade_count} · longest loss streak {r.metrics.longest_loss_streak}
            </p>
          </Panel>
          <Panel title="warnings (read these)">
            <ul className="list-disc pl-5 text-[11px] text-warn">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </Panel>
          <Panel title="position log (absolute timestamps)" className="overflow-x-auto">
            {r.positions.length === 0 && <p className="text-[11px] text-muted">no positions — parameters produced no qualifying setups</p>}
            <table className="tbl w-full" style={{ minWidth: 820 }}>
              <thead><tr><th>#</th><th>dir</th><th>signal ts</th><th>entry ts</th><th>exit ts</th><th>entry</th><th>avg exit</th><th>R</th><th>pnl (quote)</th><th>outcome</th></tr></thead>
              <tbody>
                {r.positions.slice(-60).map((tr, i) => (
                  <tr key={i}>
                    <td className="text-dim">{i + 1}</td>
                    <td style={{ color: tr.direction === "long" ? "#3fb68b" : "#d9605e" }}>{tr.direction}</td>
                    <td className="mono text-dim">{new Date(tr.signal_ts * 1000).toISOString().slice(0, 16)}</td>
                    <td className="mono text-dim">{new Date(tr.entry_ts * 1000).toISOString().slice(0, 16)}</td>
                    <td className="mono text-dim">{new Date(tr.exit_ts * 1000).toISOString().slice(0, 16)}</td>
                    <td className="mono">{tr.entry_price.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td className="mono">{tr.avg_exit_price.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td className="mono" style={{ color: tr.r_multiple >= 0 ? "#3fb68b" : "#d9605e" }}>{tr.r_multiple}</td>
                    <td className="mono">{tr.pnl_quote.toFixed(2)}</td>
                    <td className="text-muted">{tr.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="lineage (reproducibility)">
            <pre className="overflow-x-auto text-[10px] leading-relaxed text-muted">{JSON.stringify(r.lineage, null, 1)}</pre>
          </Panel>
        </>
      )}
    </div>
  );
}

function StatBox({ l, v, color }: { l: string; v: string | number; color?: string }) {
  return (
    <div className="panel-2 px-2 py-1.5">
      <div className="eyebrow">{l}</div>
      <div className="mono text-[14px] font-semibold" style={{ color }}>{v}</div>
    </div>
  );
}
