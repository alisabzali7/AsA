/**
 * GET /api/brain — brain overview: corpus coverage, counts, honest limits.
 *
 * This is the entry point of the Knowledge Explorer. It never reports a
 * capability it cannot evidence: truncated source files, unresolved conflicts
 * and untested claims are all surfaced here rather than hidden.
 */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";
import { SCORE_DISCLAIMER } from "@/lib/brain/score";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const brain = getBrain();
    const stats = brain.stats();
    const docs = brain.documents();
    const strategies = brain.strategies();

    const byRuntime: Record<string, number> = {};
    const byFamily: Record<string, number> = {};
    for (const s of strategies) {
      byRuntime[s.runtime_status] = (byRuntime[s.runtime_status] ?? 0) + 1;
      byFamily[s.family] = (byFamily[s.family] ?? 0) + 1;
    }

    const truncated = docs.filter((d) => d.truncated);

    return NextResponse.json({
      ok: true,
      ingested: stats.documents > 0,
      last_ingest_ms: Number(brain.meta("last_ingest_ms") ?? 0) || null,
      stats,
      documents: docs.map((d) => ({
        file_id: d.file_id,
        filename: d.filename,
        lines: d.total_lines,
        chars: d.total_chars,
        sha256: d.source_hash,
        truncated: d.truncated,
        truncation_note: d.truncation_note,
      })),
      strategies_by_runtime: byRuntime,
      strategies_by_family: byFamily,
      limitations: [
        ...(truncated.length
          ? [
              `${truncated.length} of 5 source files (${truncated.map((t) => t.file_id).join(", ")}) were truncated upstream at 350,000 characters. Content beyond that point is absent from the supplied package and has NOT been reconstructed.`,
            ]
          : []),
        "No strategy is empirically validated: every strategy is UNTESTED, so none can reach LIVE_ADVISORY_ONLY.",
        "Instructor claims (win rates, reversal frequencies) are stored as CLAIM and are never presented as measured performance.",
        "Risk percentages conflict across the corpus and are preserved as competing CANDIDATE policies; the production policy is an explicit operator choice.",
      ],
      score_semantics: SCORE_DISCLAIMER,
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hint: "run `npm run brain:ingest` to build the brain database",
      },
      { status: 503 },
    );
  }
}
