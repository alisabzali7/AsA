"use client";
/**
 * /brain/strategies — registry of all 104 strategies with drilldown.
 *
 * The critical question this page answers is "WHY is this disabled?" — every
 * row exposes its runtime ceiling, the missing critical fields, and (on
 * drilldown) the exact source lines, per-field VERIFIED/INFERRED labels,
 * empirical validation evidence, promotion gate checks, and provenance chain.
 */
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface StratRow {
  strategy_id: string; canonical_name: string; family: string; aliases: string[];
  source_status: string; empirical_status: string; runtime_status: string;
  runtime_ceiling: string; why: string[]; unknown_critical: string[];
  has_executable_spec: boolean; setup_ids: string[];
  source_refs: { file: string; start_line: number; end_line: number }[];
}
interface ListShape { ok: boolean; total: number; returned: number; strategies: StratRow[] }

interface DossierShape {
  ok: boolean;
  strategy: {
    strategy_id: string; canonical_name: string; family: string; aliases: string[];
    source_status: string; empirical_status: string; runtime_status: string;
    runtime_ceiling: string; why_this_status: string[]; unknown_critical: string[];
  };
  executable_spec: Record<string, string | boolean | string[] | null> | null;
  field_provenance: { field: string; source_label: string; line: number | null; value: string | null }[];
  source_quotes: { file: string; line: number; text: string; class: string }[];
  conflicts: { conflict_group_id: string; topic: string; variants: { label: string; statement: string }[] }[];
}

interface ValidationDossierShape {
  ok: boolean;
  strategy_id: string;
  strategy_state: {
    stage: string;
    exists: boolean;
    executable: boolean;
    has_validation_evidence: boolean;
    has_oos_evidence: boolean;
    promotion_eligible: boolean;
    live_eligible: boolean;
  };
  promotion_status: string;
  decision: string;
  evidenced_status: string;
  runtime_status: string;
  runtime_ceiling: string;
  blocking: string[];
  provenance_chain: {
    strategy_id: string;
    rule_ids: string[];
    compiled_setup_id: string | null;
    validation_run_id: string | null;
    dataset_source: string;
    dataset_fingerprint: string | null;
    artifact_sha256: string | null;
    fingerprint_recomputed: boolean;
    sample_period: { from_ts: number; to_ts: number; bars: number } | null;
    in_sample_period: { from_ts: number; to_ts: number; bars: number } | null;
    out_of_sample_period: { from_ts: number; to_ts: number; bars: number } | null;
    validation_methodology: string;
    trade_count_is: number;
    trade_count_oos: number;
    metrics_computed: boolean;
    promotion_decision: string;
    failure_reason: string | null;
    unknown_reason: string | null;
    code_version: string;
  };
  checks: {
    code: string;
    name: string;
    pass: boolean;
    detail: string;
    blocking: boolean;
    severity: string;
    unknown_blocking: boolean;
    unknown_reason: string | null;
  }[];
  validation_status: string;
  summary: {
    experiments_count: number;
    in_sample: { trade_count: number; avg_expectancy_r: number | null; avg_profit_factor: number | null; avg_win_rate: number | null };
    oos: { trade_count: number; avg_expectancy_r: number | null; avg_profit_factor: number | null; avg_win_rate: number | null };
    walk_forward: { total_windows: number; profitable_windows: number; avg_stability: number | null; status: string };
  };
}

const C: Record<string, string> = {
  SOURCE_VERIFIED: "#3fb68b", VERIFIED: "#3fb68b", SOURCE_INFERRED: "#d6a24a", INFERRED: "#d6a24a",
  UNKNOWN: "#8b8f98", CONFLICT: "#d05f5f", CLAIM: "#d6a24a", PLAIN: "#8b8f98",
  DISABLED: "#8b8f98", CANDIDATE: "#d6a24a", PAPER: "#7bc47f", LIVE_ADVISORY_ONLY: "#3fb68b",
  UNTESTED: "#8b8f98", BACKTESTED: "#d6a24a", OOS_TESTED: "#7bc47f", WALK_FORWARD: "#3fb68b", ROBUST: "#3fb68b",
  ELIGIBLE: "#3fb68b", NOT_ELIGIBLE: "#d05f5f", BLOCKED: "#d05f5f",
};

function Dossier({ id }: { id: string }) {
  const d = usePoll<DossierShape>(`/api/brain/explorer?strategy=${encodeURIComponent(id)}`, 0);
  const v = usePoll<ValidationDossierShape>(`/api/brain/validation?strategy=${encodeURIComponent(id)}`, 0);
  const s = d.data?.strategy;
  if (!s) return <Panel title="strategy"><div className="text-[11.5px] text-muted">Loading {id}…</div></Panel>;
  const spec = d.data?.executable_spec;
  const val = v.data;

  const stages = [
    { key: "A", label: "A: Exists", pass: val?.strategy_state.exists ?? true },
    { key: "B", label: "B: Executable", pass: val?.strategy_state.executable ?? !!spec?.executable },
    { key: "C", label: "C: Validation Evidence", pass: val?.strategy_state.has_validation_evidence ?? false },
    { key: "D", label: "D: OOS Evidence", pass: val?.strategy_state.has_oos_evidence ?? false },
    { key: "E", label: "E: Promotion Eligible", pass: val?.strategy_state.promotion_eligible ?? false },
    { key: "F", label: "F: Live Eligible", pass: val?.strategy_state.live_eligible ?? false },
  ];

  return (
    <div className="flex flex-col gap-2">
      <Panel
        title={s.canonical_name}
        right={
          <div className="flex flex-wrap gap-1">
            {val && <Badge color={C[val.promotion_status] ?? "#8b8f98"}>PROMOTION: {val.promotion_status}</Badge>}
            <Badge color={C[s.runtime_status]}>{s.runtime_status}</Badge>
            <Badge color={C[val?.evidenced_status ?? s.empirical_status]}>{val?.evidenced_status ?? s.empirical_status}</Badge>
          </div>
        }
      >
        <div className="mono mb-2 text-[9.5px] text-muted">{s.strategy_id} · {s.family}</div>

        {/* Lifecycle Stages A -> F */}
        <div className="mb-2 panel-2 p-2">
          <div className="eyebrow gold-text mb-1.5">Strategy Lifecycle & Promotion Pipeline (Stages A → F)</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
            {stages.map((st) => (
              <div
                key={st.key}
                className="flex flex-col gap-0.5 rounded border p-1.5"
                style={{
                  borderColor: st.pass ? "#3fb68b44" : "var(--color-line)",
                  background: st.pass ? "#3fb68b0d" : "transparent",
                }}
              >
                <span className="text-[10px] font-medium text-muted">{st.label}</span>
                <span className="mono text-[11px] font-semibold" style={{ color: st.pass ? "#3fb68b" : "#8b8f98" }}>
                  {st.pass ? "PASS" : "BLOCKED"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Runtime status reasoning */}
        <div className="panel-2 px-2 py-1.5">
          <div className="eyebrow gold-text mb-1">why this runtime status</div>
          <ul className="flex flex-col gap-0.5">
            {s.why_this_status.map((w, i) => <li key={i} className="text-[11px] text-muted">▸ {w}</li>)}
          </ul>
        </div>

        {/* Gaps / Blocking Reasons */}
        {val && val.blocking.length > 0 && (
          <div className="mt-2 panel-2 px-2 py-1.5" style={{ borderColor: "#d05f5f44", background: "#d05f5f0d" }}>
            <div className="eyebrow text-red mb-1" style={{ color: "#d05f5f" }}>Promotion Gate Gaps &amp; Blocking Reasons</div>
            <ul className="flex flex-col gap-0.5">
              {val.blocking.map((b, i) => (
                <li key={i} className="text-[11px]" style={{ color: "#e08888" }}>
                  ✗ {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.unknown_critical.length > 0 && (
          <div className="mt-2 text-[11px]">
            <span className="text-muted">critical fields never stated in source: </span>
            {s.unknown_critical.map((u) => <Badge key={u} color="#d05f5f">{u}</Badge>)}
          </div>
        )}
        {s.aliases.length > 1 && (
          <div className="mt-2 text-[10px] text-muted">aliases: {s.aliases.slice(0, 4).join(" · ")}</div>
        )}
      </Panel>

      {/* Validation & Empirical Evidence Panel */}
      {val && val.summary && (
        <Panel
          title="Empirical Validation Evidence (TTT Market Replay / Sync)"
          right={<span className="mono text-[10px] text-muted">{val.summary.experiments_count} experiments</span>}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="panel-2 p-2">
              <div className="eyebrow text-muted mb-1">In-Sample (70%)</div>
              <div className="space-y-0.5 text-[11px]">
                <div className="flex justify-between"><span className="text-muted">Trades:</span><span className="mono">{val.summary.in_sample.trade_count}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg Exp (R):</span><span className="mono">{val.summary.in_sample.avg_expectancy_r !== null ? val.summary.in_sample.avg_expectancy_r.toFixed(3) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg PF:</span><span className="mono">{val.summary.in_sample.avg_profit_factor !== null ? val.summary.in_sample.avg_profit_factor.toFixed(2) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg Win Rate:</span><span className="mono">{val.summary.in_sample.avg_win_rate !== null ? `${(val.summary.in_sample.avg_win_rate * 100).toFixed(1)}%` : "—"}</span></div>
              </div>
            </div>
            <div className="panel-2 p-2">
              <div className="eyebrow text-muted mb-1">Out-of-Sample (30%)</div>
              <div className="space-y-0.5 text-[11px]">
                <div className="flex justify-between"><span className="text-muted">Trades:</span><span className="mono">{val.summary.oos.trade_count}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg Exp (R):</span><span className="mono">{val.summary.oos.avg_expectancy_r !== null ? val.summary.oos.avg_expectancy_r.toFixed(3) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg PF:</span><span className="mono">{val.summary.oos.avg_profit_factor !== null ? val.summary.oos.avg_profit_factor.toFixed(2) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg Win Rate:</span><span className="mono">{val.summary.oos.avg_win_rate !== null ? `${(val.summary.oos.avg_win_rate * 100).toFixed(1)}%` : "—"}</span></div>
              </div>
            </div>
            <div className="panel-2 p-2">
              <div className="eyebrow text-muted mb-1">Walk-Forward (Rolling)</div>
              <div className="space-y-0.5 text-[11px]">
                <div className="flex justify-between"><span className="text-muted">Status:</span><span className="mono">{val.summary.walk_forward.status}</span></div>
                <div className="flex justify-between"><span className="text-muted">Windows:</span><span className="mono">{val.summary.walk_forward.profitable_windows} / {val.summary.walk_forward.total_windows}</span></div>
                <div className="flex justify-between"><span className="text-muted">Avg Stability:</span><span className="mono">{val.summary.walk_forward.avg_stability !== null ? val.summary.walk_forward.avg_stability.toFixed(2) : "—"}</span></div>
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* Promotion Gate Deterministic Checks Table */}
      {val && val.checks && val.checks.length > 0 && (
        <Panel title="Deterministic Promotion Gate Checks (15 Rules)">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted">
                <th className="text-left font-medium">check</th>
                <th className="text-left font-medium">description</th>
                <th className="text-left font-medium">verdict</th>
                <th className="text-left font-medium pl-2">audit detail</th>
              </tr>
            </thead>
            <tbody>
              {val.checks.map((chk) => (
                <tr key={chk.code} className="border-t align-top" style={{ borderColor: "var(--color-line)" }}>
                  <td className="py-1 mono text-[10px]">{chk.code}</td>
                  <td className="text-muted">{chk.name}</td>
                  <td>
                    <Badge color={chk.pass ? "#3fb68b" : chk.unknown_blocking ? "#d6a24a" : "#d05f5f"}>
                      {chk.pass ? "PASS" : chk.unknown_blocking ? "UNKNOWN" : "FAIL"}
                    </Badge>
                  </td>
                  <td className="pl-2 text-[10px] text-muted">
                    {chk.detail}
                    {chk.unknown_reason && <span className="block text-gold">Unknown: {chk.unknown_reason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {/* Provenance Chain */}
      {val && val.provenance_chain && (
        <Panel title="Data & Execution Provenance Chain">
          <div className="grid gap-2 sm:grid-cols-2 text-[11px]">
            <div className="space-y-1">
              <div><span className="text-muted">Strategy Source: </span><span className="mono">{val.provenance_chain.strategy_id}</span></div>
              <div><span className="text-muted">Corpus Rules: </span><span className="mono">{val.provenance_chain.rule_ids.join(", ") || "none"}</span></div>
              <div><span className="text-muted">Compiled Setup: </span><span className="mono">{val.provenance_chain.compiled_setup_id ?? "none"}</span></div>
              <div><span className="text-muted">Validation Run ID: </span><span className="mono">{val.provenance_chain.validation_run_id ?? "not executed"}</span></div>
            </div>
            <div className="space-y-1">
              <div><span className="text-muted">Dataset Source: </span><span className="mono">{val.provenance_chain.dataset_source}</span></div>
              <div><span className="text-muted">Artifact SHA256: </span><span className="mono">{val.provenance_chain.artifact_sha256 ? `${val.provenance_chain.artifact_sha256.slice(0, 16)}…` : "—"}</span></div>
              <div><span className="text-muted">Fingerprint: </span><span className="mono">{val.provenance_chain.dataset_fingerprint ?? "—"}</span></div>
              <div><span className="text-muted">Fingerprint Recomputed: </span><span className="mono">{val.provenance_chain.fingerprint_recomputed ? "YES" : "NO"}</span></div>
              <div><span className="text-muted">Code Version: </span><span className="mono">{val.provenance_chain.code_version.slice(0, 10)}</span></div>
            </div>
          </div>
        </Panel>
      )}

      {spec && (
        <Panel title="executable spec (from source)" right={<Badge color={spec.executable ? "#3fb68b" : "#8b8f98"}>{spec.executable ? "EXECUTABLE" : "NOT EXECUTABLE"}</Badge>}>
          {(["timeframe", "prerequisites", "entry_long", "entry_short", "confirmation", "stop", "target", "exit", "filters", "exclusions"] as const).map((k) =>
            spec[k] ? (
              <div key={k} className="border-t py-1 first:border-0" style={{ borderColor: "var(--color-line)" }}>
                <div className="text-[9.5px] uppercase tracking-wider text-muted">{k}</div>
                <div dir="auto" className="text-[11.5px]">{String(spec[k])}</div>
              </div>
            ) : null,
          )}
        </Panel>
      )}

      <Panel title="field provenance — what the instructor stated vs what was inferred">
        <table className="w-full text-[11px]">
          <thead><tr className="text-muted"><th className="text-left font-medium">field</th><th className="text-left font-medium">label</th><th className="text-right font-medium">line</th></tr></thead>
          <tbody>
            {(d.data?.field_provenance ?? []).map((f) => (
              <tr key={f.field} className="border-t" style={{ borderColor: "var(--color-line)" }}>
                <td className="py-0.5 mono">{f.field}</td>
                <td><Badge color={C[f.source_label] ?? "#8b8f98"}>{f.source_label}</Badge></td>
                <td className="mono text-right text-muted">{f.line ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-[10px] text-muted">
          VERIFIED = the instructor said it. INFERRED = the extraction deduced it. UNKNOWN = never stated, never invented.
        </p>
      </Panel>

      <Panel title="source lines (immutable corpus)">
        {(d.data?.source_quotes ?? []).slice(0, 10).map((q, i) => (
          <div key={i} className="border-t py-1 first:border-0" style={{ borderColor: "var(--color-line)" }}>
            <span className="mono text-[9.5px] text-muted">{q.file}:{q.line} [{q.class}]</span>
            <div dir="auto" className="text-[11.5px] leading-relaxed">{q.text}</div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function StrategiesInner() {
  const params = useSearchParams();
  const selected = params.get("id");
  const [runtime, setRuntime] = useState<string>("");
  const [q, setQ] = useState("");
  const list = usePoll<ListShape>(`/api/brain/strategies?limit=400${runtime ? `&runtime=${runtime}` : ""}`, 0);
  const rows = (list.data?.strategies ?? []).filter(
    (r) => !q || r.canonical_name.toLowerCase().includes(q.toLowerCase()) || r.strategy_id.toLowerCase().includes(q.toLowerCase()),
  );

  if (selected) return <Dossier id={selected} />;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[15px] font-semibold">Strategy Registry</h1>
        <StatusChip state="LIVE" label={`${list.data?.total ?? 0} STRATEGIES`} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="search name or id…"
          className="focus-ring rounded border bg-transparent px-2 py-1 text-[11.5px]"
          style={{ borderColor: "var(--color-line)" }}
        />
        {["", "DISABLED", "CANDIDATE", "PAPER", "LIVE_ADVISORY_ONLY"].map((r) => (
          <button
            key={r || "all"} onClick={() => setRuntime(r)}
            className={`focus-ring rounded border px-2 py-1 text-[10.5px] ${runtime === r ? "text-gold" : "text-muted"}`}
            style={{ borderColor: "var(--color-line)" }}
          >
            {r || "ALL"}
          </button>
        ))}
      </div>
      <Panel title={`showing ${rows.length}`}>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted">
              <th className="text-left font-medium">strategy</th>
              <th className="text-left font-medium">family</th>
              <th className="text-left font-medium">source</th>
              <th className="text-left font-medium">runtime</th>
              <th className="text-left font-medium">spec</th>
              <th className="text-left font-medium pl-2">why disabled / missing</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.strategy_id} className="border-t align-top hover:bg-white/[0.02]" style={{ borderColor: "var(--color-line)" }}>
                <td className="py-1.5">
                  <a href={`/brain/strategies?id=${r.strategy_id}`} className="focus-ring rounded text-gold hover:underline" dir="auto">
                    {r.canonical_name.slice(0, 46)}
                  </a>
                  <div className="mono text-[9px] text-muted">{r.strategy_id}</div>
                </td>
                <td className="text-muted">{r.family}</td>
                <td><Badge color={C[r.source_status] ?? "#8b8f98"}>{r.source_status.replace("SOURCE_", "")}</Badge></td>
                <td><Badge color={C[r.runtime_status] ?? "#8b8f98"}>{r.runtime_status}</Badge></td>
                <td>{r.has_executable_spec ? <Badge color="#3fb68b">YES</Badge> : <Badge color="#8b8f98">NO</Badge>}</td>
                <td className="pl-2 text-[10px] text-muted">
                  {r.unknown_critical.length > 0
                    ? <span style={{ color: "#d05f5f" }}>UNKNOWN: {r.unknown_critical.join(", ")}</span>
                    : r.why[0]?.slice(0, 90)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export default function StrategiesPage() {
  return (
    <Suspense fallback={<div className="text-[12px] text-muted">Loading…</div>}>
      <StrategiesInner />
    </Suspense>
  );
}

