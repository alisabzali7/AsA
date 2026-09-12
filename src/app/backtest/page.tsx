"use client";
/** Backtest — deterministic runs over real TTT 15m candles, full lineage. */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Badge, Empty, Panel } from "@/components/ui";

interface StrategyList { strategies: { id: string; name: string; status: string; version: string; params: Record<string, number | string | boolean> }[] }
interface BTResult {
  ok: boolean; jobId: string; status: string;
  result?: {
    ok: boolean; error?: string; lineage: unknown; warnings: string[];
    stats: { trades: number; wins: number; losses: number; win_rate: number | null; total_return_pct: number | null; profit_factor: number | null; max_drawdown_pct: number | null; avg_trade_pct: number | null; avg_win_pct: number | null; avg_loss_pct: number | null };
    trades: { direction: string; entry_time: number; exit_time: number; entry_price: number; exit_price: number; r_multiple: number; pnl_pct: number; reason: string }[];
  };
}
interface SymList { symbols: string[] }

export default function BacktestPage() {
  const { t } = useLang();
  const strats = usePoll<StrategyList>("/api/research/strategies", 120_000);
  const syms = usePoll<SymList>("/api/market/symbols", 600_000);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [params, setParams] = useState({ minMacroBars: 60, minContextBars: 40, volumeRatioMin: 0.6, fundingAbsBlock: 0.0001 });
  const [fee, setFee] = useState(0.08);
  const [slip, setSlip] = useState(0.02);
  const [policy, setPolicy] = useState<"stop_first" | "target_first">("stop_first");
  const [job, setJob] = useState<BTResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null); setJob(null);
    try {
      const res = await fetch("/api/research/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId: "reference-trend-continuation", symbol, dataMode: "ttt", sameBarPolicy: policy, feeRoundTripPct: fee, slippagePct: slip, paramsOverride: params }),
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
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">{t("nav", "backtest")}</h1>
      <Panel title="run a deterministic backtest">
        <div className="flex flex-wrap items-end gap-2 text-[11px]">
          <label className="flex flex-col gap-1"><span className="eyebrow">symbol (TTT 15m)</span>
            <select className="input w-[120px]" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(syms.data?.symbols ?? []).slice(0, 20).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1"><span className="eyebrow">fee % (round trip)</span><input className="input w-[80px]" type="number" step="0.01" value={fee} onChange={(e) => setFee(Number(e.target.value))} /></label>
          <label className="flex flex-col gap-1"><span className="eyebrow">slippage %</span><input className="input w-[80px]" type="number" step="0.005" value={slip} onChange={(e) => setSlip(Number(e.target.value))} /></label>
          <label className="flex flex-col gap-1"><span className="eyebrow">same-bar policy</span>
            <select className="input w-[130px]" value={policy} onChange={(e) => setPolicy(e.target.value as never)}>
              <option value="stop_first">STOP first (conservative)</option>
              <option value="target_first">target first (optimistic)</option>
            </select>
          </label>
          <button className="btn-gold btn" disabled={busy} onClick={() => void run()}>{busy ? "running…" : "run"}</button>
        </div>
        <details className="mt-2 text-[11px] text-muted">
          <summary className="cursor-pointer text-gold">research parameter overrides (ReferenceStrategy only — structural, not your strategy)</summary>
          <div className="mt-1.5 grid max-w-[640px] grid-cols-2 gap-1.5">
            <label className="flex items-center justify-between gap-2">minMacroBars <input className="input w-[70px]" type="number" value={params.minMacroBars} onChange={(e) => setParams({ ...params, minMacroBars: Number(e.target.value) })} /></label>
            <label className="flex items-center justify-between gap-2">minContextBars <input className="input w-[70px]" type="number" value={params.minContextBars} onChange={(e) => setParams({ ...params, minContextBars: Number(e.target.value) })} /></label>
            <label className="flex items-center justify-between gap-2">volumeRatioMin <input className="input w-[70px]" type="number" step="0.1" value={params.volumeRatioMin} onChange={(e) => setParams({ ...params, volumeRatioMin: Number(e.target.value) })} /></label>
            <label className="flex items-center justify-between gap-2">fundingAbsBlock <input className="input w-[70px]" type="number" step="0.00001" value={params.fundingAbsBlock} onChange={(e) => setParams({ ...params, fundingAbsBlock: Number(e.target.value) })} /></label>
          </div>
        </details>
        <p className="mt-2 text-[10px] text-dim">
          Strategy evaluated on CLOSED bars only · entry at next open ± slippage · stop-first ambiguity policy is explicit and recorded in lineage · funding NOT modelled (flagged) · no result here is a profit guarantee.
        </p>
      </Panel>
      {err && <div className="text-[11px]" style={{ color: "#d9605e" }}>{err}</div>}
      {job?.status === "error" && <Empty text={r?.error ?? "backtest errored"} />}
      {r?.ok && (
        <>
          <Panel title="result stats">
            <div className="grid grid-cols-3 gap-1.5 text-center sm:grid-cols-6">
              <StatBox l="trades" v={r.stats.trades} />
              <StatBox l="win rate" v={r.stats.win_rate === null ? "—" : `${r.stats.win_rate.toFixed(1)}%`} />
              <StatBox l="total %" v={r.stats.total_return_pct === null ? "—" : `${r.stats.total_return_pct > 0 ? "+" : ""}${r.stats.total_return_pct}`} color={(r.stats.total_return_pct ?? 0) >= 0 ? "#3fb68b" : "#d9605e"} />
              <StatBox l="profit factor" v={r.stats.profit_factor === null ? "—" : r.stats.profit_factor} />
              <StatBox l="max DD %" v={r.stats.max_drawdown_pct === null ? "—" : `-${r.stats.max_drawdown_pct}`} color="#d9605e" />
              <StatBox l="avg trade %" v={r.stats.avg_trade_pct === null ? "—" : r.stats.avg_trade_pct} />
            </div>
          </Panel>
          <Panel title="warnings (read these)">
            <ul className="list-disc pl-5 text-[11px] text-warn">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </Panel>
          <Panel title="trade log" className="overflow-x-auto">
            {r.trades.length === 0 && <p className="text-[11px] text-muted">no trades — parameters produced no qualifying setups</p>}
            <table className="tbl w-full" style={{ minWidth: 760 }}>
              <thead><tr><th>#</th><th>dir</th><th>entry ts</th><th>exit ts</th><th>entry</th><th>exit</th><th>R</th><th>pnl %</th><th>reason</th></tr></thead>
              <tbody>
                {r.trades.slice(-60).map((tr, i) => (
                  <tr key={i}>
                    <td className="text-dim">{i + 1}</td>
                    <td style={{ color: tr.direction === "long" ? "#3fb68b" : "#d9605e" }}>{tr.direction}</td>
                    <td className="mono text-dim">{new Date(tr.entry_time * 1000).toISOString().slice(0, 16)}</td>
                    <td className="mono text-dim">{tr.exit_time ? new Date(tr.exit_time * 1000).toISOString().slice(0, 16) : "—"}</td>
                    <td className="mono">{tr.entry_price.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td className="mono">{tr.exit_price.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td className="mono" style={{ color: tr.r_multiple >= 0 ? "#3fb68b" : "#d9605e" }}>{tr.r_multiple}</td>
                    <td className="mono">{tr.pnl_pct.toFixed(2)}</td>
                    <td className="text-muted">{tr.reason}</td>
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
      {!job && <div className="text-[10.5px] text-dim">{strats.data?.strategies.length ? `strategy: ${strats.data.strategies[0].name} (${strats.data.strategies[0].status})` : ""}</div>}
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
