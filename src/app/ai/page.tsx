"use client";
/**
 * AI Analysis — a thin human-readable projection of POST /api/ai/analyze.
 *
 * The AI layer explains deterministic evidence; it never overrides a risk
 * gate and never creates market truth. Everything below is rendered VERBATIM
 * from the typed server contract (src/lib/ai/index.ts AiResponse); the only
 * client computation is age formatting. Score is a deterministic composite —
 * never a probability (the server says so; we repeat it, we don't invent it).
 */
import { useState } from "react";
import { useLang } from "@/components/lang";
import { usePoll, postJson, fmtAge } from "@/components/hooks";
import { Badge, Empty, Panel, StatusChip } from "@/components/ui";
import { TruthState } from "@/components/data-state";
import { PageHead } from "@/components/chrome";
import { useSelection } from "@/components/selection";
import { useToast } from "@/components/toast";

interface AiResp {
  summary: string; direction: string; score: number; thesis: string; market_story: string;
  setup_quality: string; invalidation: string; confluences: string[]; contradictions: string[];
  risks: string[]; confidence: number; evidence: string[]; missing_data: string[]; risk_notes: string[];
  strategy_alignment: string; psychology_context: string; fundamental_context: string;
  data_timestamp: number; provider: string; model: string; latency_ms: number;
  status: "ok" | "fallback" | "error";
}
interface AnalyzeResult {
  ok: boolean; symbol?: string; timeframe?: string; provider_used?: string; model?: string;
  label?: "HEURISTIC MODE · NOT AN LLM" | "OLLAMA" | "OPENAI" | "HEURISTIC FALLBACK · LLM FAILED";
  response?: AiResp; error?: string | null;
}
interface SymsShape { ok: boolean; symbols: string[] }

const DIR_COLOR: Record<string, string> = { long: "var(--color-up)", short: "var(--color-down)", neutral: "var(--color-muted)", reject: "var(--color-warn)" };

export default function AiPage() {
  const { t } = useLang();
  const toast = useToast();
  const [sel, setSel] = useSelection();
  const syms = usePoll<SymsShape>("/api/market/symbols", 600_000);
  const universe = syms.data?.symbols ?? [];
  // symbol/timeframe derive from the terminal-wide selection store — the same
  // choice Chart/Market/Psychology speak about (no mirror state, no effects)
  const symbol = sel.symbol;
  const tf = sel.tf ?? "15m";
  const setSymbol = (v: string) => setSel({ symbol: v });
  const setTf = (v: string) => setSel({ tf: v });
  const [mode, setMode] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<AnalyzeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const active = symbol && universe.includes(symbol) ? symbol : universe[0] ?? null;
  const canRun = !!active && job !== undefined;

  const run = async () => {
    if (!active) return;
    setBusy(true); setErr(null);
    const j = await postJson<AnalyzeResult>("/api/ai/analyze", { symbol: active, timeframe: tf, provider: mode });
    setBusy(false);
    if (!j.ok || j.data?.ok === false) {
      setJob(null);
      setErr(j.data?.error ?? j.error ?? `HTTP ${j.status}`);
      return;
    }
    setErr(j.data?.error ?? null); // a fallback label can carry the LLM error text — keep it visible
    setJob(j.data);
    if (active) setSel({ symbol: active, tf, returnTo: "/ai" });
    toast.push({
      title: j.data?.label === "OLLAMA" || j.data?.label === "OPENAI" ? "LLM analysis complete" : "analysis complete (deterministic path)",
      body: `${active} ${tf} — ${j.data?.label ?? "provider verdict pending"}`,
      tone: j.data?.label === "HEURISTIC MODE · NOT AN LLM" ? "info" : "success",
    });
  };

  const r = job?.response;
  return (
    <div className="flex flex-col gap-2">
      <PageHead
        title={t("nav", "ai_analysis")}
        sub="Structured explanation over deterministic evidence — the AI cannot place orders, override risk, or create data."
        right={active ? <span className="mono text-[10.5px] text-gold">{active} · {tf}</span> : undefined}
      />

      {syms.status !== "OK" ? (
        <TruthState status={syms.status} failure={syms.failure} onRetry={syms.refresh} loadingText="loading the TTT universe…" />
      ) : (
        <Panel title="run an analysis">
          <div className="flex flex-wrap items-end gap-2 text-[11px]">
            <label className="flex flex-col gap-1"><span className="eyebrow">symbol</span>
              <select className="input w-[150px]" value={active ?? ""} onChange={(e) => setSymbol(e.target.value)} aria-label="symbol">
                {universe.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1"><span className="eyebrow">timeframe</span>
              <select className="input w-[90px]" value={tf} onChange={(e) => setTf(e.target.value)} aria-label="timeframe">
                {["15m", "1h", "4h", "1d", "5m", "30m", "2h", "8h"].map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1"><span className="eyebrow">provider mode</span>
              <select className="input w-[190px]" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="provider mode">
                <option value="auto">auto — configured LLM, else heuristic</option>
                <option value="heuristic">heuristic only (deterministic, NOT an LLM)</option>
                <option value="ollama">ollama</option>
                <option value="openai">openai-compatible</option>
              </select>
            </label>
            <button className={`btn-gold btn ${canRun ? "" : "opacity-50"}`} disabled={busy || !active} onClick={() => void run()}>{busy ? "running…" : "analyze"}</button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-dim">
            Analysis runs on closed bars only; the forming bar is excluded server-side. Result is advisory — the human executes.
          </p>
        </Panel>
      )}

      {err && <div role="alert" className="panel-2 px-3 py-2 text-[11.5px]" style={{ color: "var(--color-down)" }}>{err}</div>}

      {r && (
        <div className="flex flex-col gap-2">
          <div className="rise" style={{ ["--i" as never]: 0 }}>
          <Panel title="verdict (server-generated)" right={<StatusChip state={job?.response?.status === "ok" ? "READY" : job?.response?.status === "fallback" ? "DEGRADED" : "ERROR"} label={String(job?.label ?? "").slice(0, 40)} />}>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <Badge color={DIR_COLOR[r.direction] ?? "var(--color-muted)"}>{r.direction.toUpperCase()}</Badge>
              <Badge color="var(--color-gold)">score {r.score}/100 · deterministic score, NOT a probability</Badge>
              <Badge>setup {r.setup_quality}</Badge>
              <Badge color={r.status === "ok" ? "var(--color-up)" : "var(--color-down)"}>{r.provider}{r.model ? ` · ${r.model}` : ""} · {r.latency_ms}ms</Badge>
              <span className="text-dim" dir="ltr">evidence closed {new Date(r.data_timestamp).toISOString().slice(0, 16)}Z · {job?.symbol} {job?.timeframe}</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-text" dir="auto">{r.summary}</p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted" dir="auto">{r.thesis}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted" dir="auto">{r.market_story}</p>
          </Panel>
          </div>
          <div className="rise grid gap-2 md:grid-cols-2" style={{ ["--i" as never]: 1 }}>
            <Panel title="confluences"><List items={r.confluences} color="var(--color-up)" /></Panel>
            <Panel title="contradictions"><List items={r.contradictions} color="var(--color-down)" /></Panel>
            <Panel title="risks"><List items={r.risks} color="var(--color-warn)" /></Panel>
            <Panel title="missing data"><List items={r.missing_data} color="var(--color-muted)" emptyText="nothing missing per the assembled evidence" /></Panel>
          </div>
          <div className="rise grid gap-2 md:grid-cols-3" style={{ ["--i" as never]: 2 }}>
            <Panel title="invalidation"><p className="text-[11.5px] text-muted" dir="auto">{r.invalidation}</p></Panel>
            <Panel title="strategy alignment"><p className="text-[11.5px] text-muted" dir="auto">{r.strategy_alignment}</p></Panel>
            <Panel title="psychology context"><p className="text-[11.5px] text-muted" dir="auto">{r.psychology_context}</p></Panel>
          </div>
          <Panel title="evidence (deterministic inputs the verdict is built from)" className="rise" i={3}>
            <ul className="space-y-0.5 text-[10.5px] text-muted">
              {r.evidence.map((e, i) => <li key={i} dir="auto" className="mono">· {e}</li>)}
              {r.risk_notes.map((n, i) => <li key={`rn-${i}`} dir="auto" style={{ color: "var(--color-warn)" }}>risk note: {n}</li>)}
              {r.fundamental_context && <li dir="auto" className="text-dim">news context: {r.fundamental_context}</li>}
            </ul>
          </Panel>
        </div>
      )}
      {!r && !err && syms.status === "OK" && universe.length === 0 && <Empty text="the universe is empty (TTT discovery incomplete) — there is nothing real to analyze yet" />}
    </div>
  );
}

function List({ items, color, emptyText = "the server returned none" }: { items: string[]; color: string; emptyText?: string }) {
  if (!items || items.length === 0) return <p className="text-[11px] text-dim">{emptyText}</p>;
  return (
    <ul className="space-y-0.5 text-[11px] text-muted">
      {items.map((x, i) => <li key={i} dir="auto" className="flex gap-1.5"><span aria-hidden style={{ color }}>▪</span><span>{x}</span></li>)}
    </ul>
  );
}
