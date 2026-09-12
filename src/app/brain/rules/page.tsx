"use client";
/**
 * /brain/rules — executable rule registry with source drilldown.
 * Shows the verbatim corpus sentence behind every machine predicate.
 */
import { useState } from "react";
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface Rule {
  rule_id: string; strategy_id: string; setup_id: string; kind: string;
  description: string; source_text: string; source_status: string; empirical_status: string;
  feature_dependencies: string[]; predicates: { expr: string; requires: string[] }[];
  operator: string; timeframe: string; direction: string; unresolved: string[]; executable: boolean;
  source_refs: { file: string; start_line: number }[];
}
interface Shape { ok: boolean; executable_rules: number; stored_source_rules: number; note: string; rules: Rule[] }

const C: Record<string, string> = {
  SOURCE_VERIFIED: "#3fb68b", SOURCE_INFERRED: "#d6a24a", UNKNOWN: "#8b8f98",
  CONFLICT: "#d05f5f", CLAIM: "#d6a24a", UNTESTED: "#8b8f98",
  context: "#7bc47f", location: "#3fb68b", structure: "#3fb68b",
  trigger: "#d6a24a", confirmation: "#7bc47f", invalidation: "#d05f5f", filter: "#8b8f98",
};

export default function RulesPage() {
  const d = usePoll<Shape>("/api/brain/rules?predicates=1", 0);
  const [kind, setKind] = useState("");
  const rows = (d.data?.rules ?? []).filter((r) => !kind || r.kind === kind);
  const kinds = [...new Set((d.data?.rules ?? []).map((r) => r.kind))];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Rule Registry</h1>
        <StatusChip state="LIVE" label={`${d.data?.executable_rules ?? 0} EXECUTABLE`} />
      </div>
      <p className="text-[11px] text-muted">{d.data?.note}</p>
      <div className="flex flex-wrap gap-1.5">
        {["", ...kinds].map((k) => (
          <button key={k || "all"} onClick={() => setKind(k)}
            className={`focus-ring rounded border px-2 py-1 text-[10.5px] ${kind === k ? "text-gold" : "text-muted"}`}
            style={{ borderColor: "var(--color-line)" }}>{k || "ALL"}</button>
        ))}
      </div>
      {rows.map((r) => (
        <Panel key={r.rule_id} title={r.rule_id}
          right={<div className="flex gap-1"><Badge color={C[r.kind]}>{r.kind}</Badge><Badge color={C[r.source_status]}>{r.source_status.replace("SOURCE_", "")}</Badge><Badge color={r.executable ? "#3fb68b" : "#d05f5f"}>{r.executable ? "EXECUTABLE" : "NON_COMPUTABLE"}</Badge></div>}>
          <div className="text-[11.5px]">{r.description}</div>
          {r.source_text && (
            <div dir="auto" className="mt-1.5 rounded px-2 py-1 text-[11px] leading-relaxed" style={{ background: "rgba(255,255,255,0.03)" }}>
              {r.source_text}
            </div>
          )}
          <div className="mono mt-1 text-[9.5px] text-muted">
            {r.source_refs.map((x) => `${x.file}:${x.start_line}`).join(" · ")} · {r.timeframe} · {r.direction} · {r.operator}
          </div>
          {r.predicates.length > 0 && (
            <div className="mt-1.5">
              <div className="eyebrow gold-text mb-0.5">predicates</div>
              {r.predicates.map((p, i) => (
                <div key={i} className="mono text-[10px] text-muted">▸ {p.expr}</div>
              ))}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {r.feature_dependencies.map((f) => <Badge key={f}>{f}</Badge>)}
          </div>
          {r.unresolved.length > 0 && (
            <div className="mt-1 text-[10.5px]" style={{ color: "#d05f5f" }}>NON-COMPUTABLE: {r.unresolved.join("; ")}</div>
          )}
        </Panel>
      ))}
    </div>
  );
}
