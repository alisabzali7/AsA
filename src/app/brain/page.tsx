"use client";
/**
 * /brain — Knowledge Explorer overview (Phase 2 §17, §24).
 *
 * Answers "what does the brain know?" with corpus coverage, honest limitations
 * and the empirical state of every compiled strategy. Nothing is displayed as
 * certain unless the API can evidence it.
 */
import Link from "next/link";
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface BrainShape {
  ok: boolean;
  ingested: boolean;
  stats: Record<string, number>;
  documents: { file_id: string; filename: string; lines: number; chars: number; sha256: string; truncated: boolean; truncation_note: string | null }[];
  strategies_by_runtime: Record<string, number>;
  strategies_by_family: Record<string, number>;
  limitations: string[];
  score_semantics: string;
}

interface ValidationShape {
  ok: boolean;
  total_experiments: number;
  strategies: {
    strategy_id: string; name: string; family: string; setups: string[];
    empirical_status: string; experiments: number; symbols_tested: string[];
    runtime_status: string; runtime_ceiling: string; why: string[]; blocking: string[];
  }[];
  criteria: Record<string, unknown>;
}

const STATUS_COLOR: Record<string, string> = {
  ROBUST: "#3fb68b", WALK_FORWARD: "#3fb68b", OOS_TESTED: "#7bc47f",
  BACKTESTED: "#d6a24a", UNTESTED: "#8b8f98", REJECTED: "#d05f5f",
  LIVE_ADVISORY_ONLY: "#3fb68b", CANDIDATE: "#d6a24a", PAPER: "#7bc47f", DISABLED: "#8b8f98",
};

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="panel-2 flex flex-col gap-0.5 px-2.5 py-2">
      <span className="text-[9.5px] uppercase tracking-wider text-muted">{label}</span>
      <span className="mono text-[15px] font-semibold" style={{ color: tone }}>{value}</span>
    </div>
  );
}

export default function BrainPage() {
  const b = usePoll<BrainShape>("/api/brain", 60_000);
  const v = usePoll<ValidationShape>("/api/brain/validation", 60_000);
  const d = b.data;
  const s = d?.stats ?? {};

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Knowledge Explorer</h1>
        <StatusChip state={d?.ingested ? "LIVE" : "UNAVAILABLE"} label={d?.ingested ? "BRAIN LOADED" : "NOT INGESTED"} />
      </div>

      {!d && <div className="panel-2 px-3 py-6 text-[12px] text-muted">Loading brain… if this persists, run <span className="mono">npm run brain:ingest</span>.</div>}

      {d && (
        <>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="source lines" value={s.fragments ?? 0} />
            <Stat label="strategies" value={s.strategies ?? 0} />
            <Stat label="rules" value={s.rules ?? 0} />
            <Stat label="unknowns" value={s.unknowns ?? 0} tone="#d6a24a" />
            <Stat label="conflicts" value={s.conflicts ?? 0} tone="#d6a24a" />
            <Stat label="claims" value={s.claims ?? 0} tone="#d6a24a" />
          </div>

          <div className="grid gap-2 lg:grid-cols-2">
            <Panel title="corpus documents (immutable)">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left font-medium">file</th>
                    <th className="text-right font-medium">lines</th>
                    <th className="text-right font-medium">chars</th>
                    <th className="text-left font-medium pl-2">sha256</th>
                    <th className="text-left font-medium">state</th>
                  </tr>
                </thead>
                <tbody className="mono">
                  {d.documents.map((doc) => (
                    <tr key={doc.file_id} className="border-t" style={{ borderColor: "var(--color-line)" }}>
                      <td className="py-1">{doc.file_id}</td>
                      <td className="text-right">{doc.lines}</td>
                      <td className="text-right">{doc.chars.toLocaleString()}</td>
                      <td className="pl-2 text-muted">{doc.sha256.slice(0, 10)}…</td>
                      <td>{doc.truncated ? <Badge color="#d6a24a">TRUNCATED</Badge> : <Badge color="#3fb68b">COMPLETE</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="honest limitations">
              <ul className="flex flex-col gap-1.5">
                {d.limitations.map((l, i) => (
                  <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
                    <span style={{ color: "#d6a24a" }}>▸</span>
                    <span className="text-muted">{l}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <Panel
            title="compiled strategies — empirical evidence"
            right={<span className="text-[10px] text-muted mono">{v.data?.total_experiments ?? 0} experiments</span>}
          >
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-muted">
                  <th className="text-left font-medium">strategy</th>
                  <th className="text-left font-medium">family</th>
                  <th className="text-left font-medium">empirical</th>
                  <th className="text-left font-medium">runtime</th>
                  <th className="text-right font-medium">exp</th>
                  <th className="text-left font-medium pl-2">why not live</th>
                </tr>
              </thead>
              <tbody>
                {(v.data?.strategies ?? []).map((st) => (
                  <tr key={st.strategy_id} className="border-t align-top" style={{ borderColor: "var(--color-line)" }}>
                    <td className="py-1.5">
                      <Link href={`/brain/strategies?id=${st.strategy_id}`} className="focus-ring rounded text-gold hover:underline">
                        {st.name}
                      </Link>
                      <div className="mono text-[9.5px] text-muted">{st.strategy_id}</div>
                    </td>
                    <td className="text-muted">{st.family}</td>
                    <td><Badge color={STATUS_COLOR[st.empirical_status] ?? "#8b8f98"}>{st.empirical_status}</Badge></td>
                    <td><Badge color={STATUS_COLOR[st.runtime_status] ?? "#8b8f98"}>{st.runtime_status}</Badge></td>
                    <td className="mono text-right">{st.experiments}</td>
                    <td className="pl-2 text-[10px] text-muted">{st.blocking[0] ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-muted">{d.score_semantics}</p>
          </Panel>

          <div className="grid gap-2 lg:grid-cols-3">
            <Panel title="explore">
              <div className="flex flex-col gap-1">
                <Link href="/brain/strategies" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → all {s.strategies ?? 0} strategies &amp; why they are disabled
                </Link>
                <Link href="/brain/rules" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → executable rule registry
                </Link>
                <Link href="/brain/unknowns" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → {s.unknowns ?? 0} unknowns (never invented)
                </Link>
                <Link href="/brain/conflicts" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → {s.conflicts ?? 0} conflict groups (never averaged)
                </Link>
                <Link href="/brain/risk" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → {s.risk_policies ?? 0} risk policies
                </Link>
                <Link href="/brain/psychology" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → {s.psychology_policies ?? 0} psychology policies
                </Link>
                <Link href="/brain/search" className="focus-ring rounded px-1 py-1 text-[11.5px] text-gold hover:underline">
                  → search {(s.fragments ?? 0).toLocaleString()} source lines
                </Link>
              </div>
            </Panel>
            <Panel title="strategies by runtime status">
              {Object.entries(d.strategies_by_runtime).map(([k, n]) => (
                <div key={k} className="flex items-center justify-between py-0.5 text-[11.5px]">
                  <Badge color={STATUS_COLOR[k] ?? "#8b8f98"}>{k}</Badge>
                  <span className="mono">{n}</span>
                </div>
              ))}
            </Panel>
            <Panel title="strategies by family">
              <div className="flex flex-wrap gap-1">
                {Object.entries(d.strategies_by_family).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                  <span key={k} className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--color-line)" }}>
                    <span className="text-muted">{k}</span> <span className="mono">{n}</span>
                  </span>
                ))}
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
