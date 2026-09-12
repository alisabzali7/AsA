"use client";
/**
 * /brain/search — full-text search across every ingested source line.
 * Quarantined commentary is returned but visibly marked, so the user can see
 * both what AsA learned and what it deliberately refused to learn from.
 */
import { useState } from "react";
import { Badge, Panel } from "@/components/ui";

interface Hit { file: string; line: number; text: string; class: string; tags: string[]; quarantined: boolean }

const CLASS_COLOR: Record<string, string> = {
  RULE_CANDIDATE: "#3fb68b", STRATEGY_DECL: "#3fb68b", UNKNOWN_MARKER: "#d6a24a",
  CONFLICT_MARKER: "#d05f5f", CLAIM: "#d6a24a", META_COMMENTARY: "#8b8f98",
  PSYCHOLOGY: "#7bc47f", RISK: "#7bc47f", SECTION_HEADER: "#8b8f98", NARRATIVE: "#8b8f98",
};

export default function BrainSearchPage() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brain/explorer?q=${encodeURIComponent(q)}&limit=80`);
      const j = (await r.json()) as { hits?: Hit[] };
      setHits(j.hits ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[15px] font-semibold">Source Search</h1>
      <p className="text-[11px] text-muted">
        Searches all 9,398 ingested source lines. Every hit shows its file, line number and classification.
      </p>
      <form onSubmit={run} className="flex gap-1.5">
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. PRZ, اردر بلاک, ریسک, فیبوناچی…" dir="auto"
          className="focus-ring flex-1 rounded border bg-transparent px-2 py-1.5 text-[12px]"
          style={{ borderColor: "var(--color-line)" }}
        />
        <button type="submit" disabled={busy} className="focus-ring rounded border px-3 py-1.5 text-[11.5px] text-gold" style={{ borderColor: "var(--color-line)" }}>
          {busy ? "…" : "search"}
        </button>
      </form>

      {hits && (
        <Panel title={`${hits.length} matches`}>
          {hits.length === 0 && <div className="text-[11.5px] text-muted">No source line contains that text.</div>}
          {hits.map((h, i) => (
            <div key={i} className="border-t py-1.5 first:border-0" style={{ borderColor: "var(--color-line)" }}>
              <div className="mb-0.5 flex flex-wrap items-center gap-1">
                <span className="mono text-[9.5px] text-muted">{h.file}:{h.line}</span>
                <Badge color={CLASS_COLOR[h.class] ?? "#8b8f98"}>{h.class}</Badge>
                {h.quarantined && <Badge color="#d05f5f">QUARANTINED — never executable</Badge>}
                {h.tags.slice(0, 4).map((t) => <Badge key={t}>{t}</Badge>)}
              </div>
              <div dir="auto" className="text-[11.5px] leading-relaxed">{h.text}</div>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
