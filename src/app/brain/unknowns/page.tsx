"use client";
/**
 * /brain/unknowns — everything the corpus left unspecified, made browsable.
 * UNKNOWN is a first-class fact here, never hidden behind a status chip.
 */
import { usePoll } from "@/components/hooks";
import { Badge, Panel, StatusChip } from "@/components/ui";

interface Shape {
  ok: boolean;
  total_unknown_lines: number;
  strategies_blocked_by_unknown: number;
  unknown_by_critical_field: Record<string, number>;
  strategies: { strategy_id: string; canonical_name: string; family: string; unknown_critical: string[]; runtime_status: string }[];
  source_lines: { file: string; line: number; text: string; tags: string[] }[];
  note: string;
}

export default function UnknownsPage() {
  const d = usePoll<Shape>("/api/brain/unknowns?limit=120", 0);
  const s = d.data;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold">Unknowns</h1>
        <StatusChip state="DEGRADED" label={`${s?.total_unknown_lines ?? 0} UNKNOWN LINES`} />
      </div>
      <p className="text-[11px] text-muted">{s?.note}</p>

      <Panel title="missing critical fields, by field">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(s?.unknown_by_critical_field ?? {}).sort((a, b) => b[1] - a[1]).map(([f, n]) => (
            <span key={f} className="rounded border px-2 py-1 text-[11px]" style={{ borderColor: "var(--color-line)" }}>
              <span style={{ color: "#d05f5f" }}>{f}</span> <span className="mono">{n}</span>
            </span>
          ))}
        </div>
      </Panel>

      <Panel title={`strategies blocked by UNKNOWN (${s?.strategies_blocked_by_unknown ?? 0})`}>
        <table className="w-full text-[11px]">
          <thead><tr className="text-muted"><th className="text-left font-medium">strategy</th><th className="text-left font-medium">family</th><th className="text-left font-medium">missing</th></tr></thead>
          <tbody>
            {(s?.strategies ?? []).slice(0, 60).map((x) => (
              <tr key={x.strategy_id} className="border-t" style={{ borderColor: "var(--color-line)" }}>
                <td className="py-1" dir="auto">{x.canonical_name.slice(0, 44)}<div className="mono text-[9px] text-muted">{x.strategy_id}</div></td>
                <td className="text-muted">{x.family}</td>
                <td>{x.unknown_critical.map((u) => <Badge key={u} color="#d05f5f">{u}</Badge>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="UNKNOWN-marked source lines">
        {(s?.source_lines ?? []).slice(0, 60).map((l, i) => (
          <div key={i} className="border-t py-1 first:border-0" style={{ borderColor: "var(--color-line)" }}>
            <span className="mono text-[9.5px] text-muted">{l.file}:{l.line}</span>
            <div dir="auto" className="text-[11px]">{l.text}</div>
          </div>
        ))}
      </Panel>
    </div>
  );
}
