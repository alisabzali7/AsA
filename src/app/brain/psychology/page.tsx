"use client";
/**
 * /brain/psychology — psychology policy registry.
 * Psychology can block, penalize, require a checklist or flag — it never
 * creates a signal, and it never diagnoses the user.
 */
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface Policy {
  policy_id: string; canonical_name: string; description: string; effect: string;
  score_penalty: number; trigger_condition: string; runtime_status: string;
  user_overridable: boolean; source_refs: { file: string; start_line: number; quote?: string }[];
}
interface Shape { ok: boolean; psychology_policies: Policy[] }

const EFFECT: Record<string, string> = {
  BLOCK: "#d05f5f", REDUCE_SCORE: "#d6a24a", REQUIRE_CHECKLIST: "#7bc47f", FLAG: "#8b8f98",
};

export default function PsychologyPolicyPage() {
  const d = usePoll<Shape>("/api/brain/policies", 0);
  const rows = d.data?.psychology_policies ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Psychology Policies</h1>
        <StatusChip state="READY" label={`${rows.length} POLICIES`} />
      </div>
      <p className="text-[11px] text-muted">
        These gates only ever restrict advisory output. AsA records the user&apos;s own declarations and never
        infers a psychological or medical diagnosis.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map((p) => (
          <Panel key={p.policy_id} title={p.canonical_name} right={<Badge color={EFFECT[p.effect] ?? "#8b8f98"}>{p.effect}</Badge>}>
            <div className="mono mb-1 text-[9px] text-muted">{p.policy_id}</div>
            <div dir="auto" className="text-[11px] leading-relaxed">{p.description}</div>
            <div className="mono mt-1.5 rounded px-1.5 py-1 text-[10px] text-muted" style={{ background: "rgba(255,255,255,0.03)" }}>
              {p.trigger_condition}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted">
              {p.score_penalty > 0 && <span>penalty −{p.score_penalty}</span>}
              <span>{p.user_overridable ? "user-overridable" : "not overridable"}</span>
            </div>
            {p.source_refs.map((r, i) => (
              <div key={i} className="mt-1 text-[10px]">
                <span className="mono text-muted">{r.file}:{r.start_line}</span> <span dir="auto">{r.quote}</span>
              </div>
            ))}
          </Panel>
        ))}
      </div>
    </div>
  );
}
