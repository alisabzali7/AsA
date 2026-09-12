"use client";
/**
 * /brain/conflicts — competing source claims, preserved side by side.
 * The point of this page is to prove AsA did NOT resolve disagreements by
 * averaging or by silently picking a winner.
 */
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface Shape {
  ok: boolean;
  conflicts: {
    conflict_group_id: string; topic: string; resolution: string; chosen_variant: string | null;
    variants: { label: string; statement: string; source_refs: { file: string; start_line: number }[] }[];
  }[];
}

export default function ConflictsPage() {
  const d = usePoll<Shape>("/api/brain/policies", 0);
  const groups = d.data?.conflicts ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Conflicts</h1>
        <StatusChip state="DEGRADED" label={`${groups.length} GROUPS · UNRESOLVED`} />
      </div>
      <p className="text-[11px] text-muted">
        The corpus contradicts itself in places. Every competing variant is preserved verbatim with its source line.
        AsA never averages them and never promotes one silently — resolution is an explicit operator decision.
      </p>

      {groups.map((g) => (
        <Panel
          key={g.conflict_group_id}
          title={g.topic}
          right={<Badge color={g.resolution === "UNRESOLVED" ? "#d6a24a" : "#3fb68b"}>{g.resolution}</Badge>}
        >
          <div className="mono mb-1.5 text-[9.5px] text-muted">{g.conflict_group_id}</div>
          <div className="grid gap-1.5 md:grid-cols-2">
            {g.variants.slice(0, 12).map((v, i) => (
              <div key={i} className="panel-2 px-2 py-1.5">
                <div className="mb-0.5 text-[10.5px] font-semibold text-gold">{v.label}</div>
                <div dir="auto" className="text-[11px] leading-relaxed text-muted">{v.statement.slice(0, 400)}</div>
                {v.source_refs?.length > 0 && (
                  <div className="mono mt-1 text-[9px] text-muted">
                    {v.source_refs.map((r) => `${r.file}:${r.start_line}`).join(" · ")}
                  </div>
                )}
              </div>
            ))}
          </div>
          {g.variants.length > 12 && (
            <div className="mt-1 text-[10px] text-muted">+{g.variants.length - 12} more variants preserved in the brain</div>
          )}
        </Panel>
      ))}
    </div>
  );
}
