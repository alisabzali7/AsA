"use client";
/** Research — hypotheses w/ honest statuses, strategy rule registry, AI audit. */
import { useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { Badge, Panel } from "@/components/ui";

interface ResearchShape {
  ok: boolean;
  hypotheses: { id: string; title: string; status: string; evidence: string; tested: boolean }[];
  strategies: { id: string; name: string; status: string; executable: boolean; live_eligible: boolean; rules: Record<string, string[]>; params: Record<string, unknown>; ruleDocs?: never }[];
  exit_policy: { id: string; description: string };
}
interface AiCallsShape { ok: boolean; items: { id: number; created_ms: number; provider: string; model: string; latency_ms: number | null; verdict: string }[] }

const H_COLORS: Record<string, string> = { UNTESTED: "#8b8f99", RESEARCH_CANDIDATE: "#d6a24a", DATA_LIMITED: "#d6a24a", EXPERIMENTAL: "#d4b874", VALIDATED: "#3fb68b", REJECTED: "#d9605e", REFERENCE: "#8b8f99" };

export default function ResearchPage() {
  const { t } = useLang();
  const r = usePoll<ResearchShape>("/api/research/strategies", 120_000);
  const calls = usePoll<AiCallsShape>("/api/research/ai-calls", 20000);
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">{t("nav", "research")}</h1>
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="hypotheses (registry — claims carry evidence state)">
          {r.data?.hypotheses.map((h) => (
            <div key={h.id} className="panel-2 mb-1.5 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium">{h.title}</span>
                <Badge color={H_COLORS[h.status] ?? "#8b8f99"}>{h.status}</Badge>
              </div>
              <p className="mt-0.5 text-[10.5px] text-muted">{h.evidence}</p>
            </div>
          ))}
          <p className="text-[9.5px] text-dim">no hypothesis here claims validation — tested=false means: not tested, stated plainly.</p>
        </Panel>
        <Panel title="strategy registry (pluggable)">
          {r.data?.strategies.map((s) => (
            <details key={s.id} className="panel-2 mb-1.5 px-2 py-1.5">
              <summary className="cursor-pointer text-[12px]">
                {s.name} <Badge color={H_COLORS[s.status] ?? "#8b8f99"}>{s.status}</Badge>
                {s.executable && <Badge color="#d6b04a">EXECUTABLE</Badge>}
                {s.live_eligible && <Badge color="#3fb68b">LIVE ELIGIBLE</Badge>}
              </summary>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {Object.entries(s.rules).map(([cat, rules]) => (
                  <div key={cat} className="text-[10px]">
                    <div className="eyebrow">{cat}</div>
                    <ul className="list-disc pl-3.5 text-muted">{rules.map((r2, i) => <li key={i}>{r2}</li>)}</ul>
                  </div>
                ))}
              </div>
            </details>
          ))}
          <p className="mt-1 text-[9.5px] text-dim">exit policy: {r.data?.exit_policy.id} — {r.data?.exit_policy.description.slice(0, 140)}…</p>
        </Panel>
      </div>
      <Panel title="AI audit trail (structured outputs only)">
        <div className="overflow-x-auto">
          <table className="tbl w-full" style={{ minWidth: 640 }}>
            <thead><tr><th>time</th><th>provider</th><th>model</th><th>latency</th><th>verdict</th></tr></thead>
            <tbody>
              {calls.data?.items.slice(0, 40).map((c) => (
                <tr key={c.id}>
                  <td className="mono text-dim">{new Date(c.created_ms).toLocaleString()}</td>
                  <td>{c.provider}</td>
                  <td className="mono text-dim">{c.model}</td>
                  <td className="mono">{c.latency_ms === null ? "—" : `${c.latency_ms}ms`}</td>
                  <td style={{ color: c.verdict === "reject" ? "#d9605e" : c.verdict === "neutral" ? "#8b8f99" : "#3fb68b" }}>{c.verdict}</td>
                </tr>
              ))}
              {calls.data?.items.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-muted">no AI calls yet</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
