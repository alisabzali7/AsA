"use client";
/**
 * /brain/risk — risk policy registry.
 * Shows every corpus-derived policy with its source lines, plus which fields
 * a policy does NOT specify (those checks are skipped, never defaulted).
 */
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface Policy {
  policy_id: string; canonical_name: string;
  risk_per_trade_pct: number | null; daily_loss_limit_pct: number | null;
  max_account_risk_pct: number | null; period_loss_limit_pct: number | null;
  max_leverage: number | null; max_concurrent_positions: number | null;
  source_status: string; conflict_group_id: string | null; runtime_status: string; notes: string;
  source_refs: { file: string; start_line: number; quote?: string }[];
}
interface Shape { ok: boolean; risk_policies: Policy[] }

const C: Record<string, string> = {
  SOURCE_VERIFIED: "#3fb68b", SOURCE_INFERRED: "#d6a24a", CONFLICT: "#d05f5f", CLAIM: "#d6a24a",
  CANDIDATE: "#d6a24a", DISABLED: "#8b8f98", LIVE_ADVISORY_ONLY: "#3fb68b",
};
const num = (v: number | null) => (v === null ? <span className="text-muted">—</span> : <span className="mono">{v}%</span>);

export default function RiskPage() {
  const d = usePoll<Shape>("/api/brain/policies", 0);
  const rows = d.data?.risk_policies ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Risk Policies</h1>
        <StatusChip state="READY" label={`${rows.length} POLICIES`} />
      </div>
      <p className="text-[11px] text-muted">
        A dash means the corpus never stated that limit for this policy — the corresponding check is skipped
        and reported as unenforced, never replaced with an invented default.
      </p>

      <Panel title="policy matrix">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted">
              <th className="text-left font-medium">policy</th>
              <th className="text-right font-medium">per trade</th>
              <th className="text-right font-medium">daily</th>
              <th className="text-right font-medium">account</th>
              <th className="text-right font-medium">period</th>
              <th className="text-left font-medium pl-2">source</th>
              <th className="text-left font-medium">runtime</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.policy_id} className="border-t align-top" style={{ borderColor: "var(--color-line)" }}>
                <td className="py-1.5">
                  <div className="text-[11.5px]">{p.canonical_name}</div>
                  <div className="mono text-[9px] text-muted">{p.policy_id}</div>
                </td>
                <td className="text-right">{num(p.risk_per_trade_pct)}</td>
                <td className="text-right">{num(p.daily_loss_limit_pct)}</td>
                <td className="text-right">{num(p.max_account_risk_pct)}</td>
                <td className="text-right">{num(p.period_loss_limit_pct)}</td>
                <td className="pl-2"><Badge color={C[p.source_status] ?? "#8b8f98"}>{p.source_status.replace("SOURCE_", "")}</Badge></td>
                <td><Badge color={C[p.runtime_status] ?? "#8b8f98"}>{p.runtime_status}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {rows.map((p) => (
        <Panel key={p.policy_id} title={p.canonical_name} right={p.conflict_group_id ? <Badge color="#d05f5f">IN CONFLICT GROUP</Badge> : undefined}>
          <div dir="auto" className="mb-1.5 text-[11px] leading-relaxed text-muted">{p.notes}</div>
          {p.source_refs.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {p.source_refs.map((r, i) => (
                <div key={i} className="text-[10.5px]">
                  <span className="mono text-muted">{r.file}:{r.start_line}</span>{" "}
                  <span dir="auto">{r.quote}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10.5px]" style={{ color: "#d6a24a" }}>
              no source refs — this policy is an explicit engineering assumption, not an instructor statement
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
