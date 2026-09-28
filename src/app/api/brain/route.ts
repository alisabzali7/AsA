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
import { CORPUS_FILES } from "@/lib/brain/corpus-manifest";

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

    const expectedById = new Map(CORPUS_FILES.map((source) => [source.file_id, source]));
    const documents = docs.map((d) => {
      const expected = expectedById.get(d.file_id);
      const identity_status = !expected
        ? "UNKNOWN" as const
        : d.source_hash !== expected.expected_sha256
          || d.total_lines !== expected.expected_lines
          || d.total_chars !== expected.expected_chars
          || (d.total_bytes !== 0 && d.total_bytes !== expected.expected_bytes)
          ? "MISMATCH" as const
          : d.total_bytes === 0 ? "UNKNOWN" as const : "MATCH" as const;
      const storedTruncationAgrees = expected
        ? d.truncated === (expected.completeness === "TRUNCATED")
        : false;
      const completeness = identity_status === "MATCH" && storedTruncationAgrees
        ? expected!.completeness
        : "UNKNOWN" as const;
      return {
        file_id: d.file_id,
        filename: d.filename,
        lines: d.total_lines,
        chars: d.total_chars,
        bytes: d.total_bytes,
        sha256: d.source_hash,
        identity_status,
        manifest_completeness: expected?.completeness ?? "UNKNOWN",
        ingested_truncated: d.truncated,
        completeness,
        truncated: completeness === "TRUNCATED",
        truncation_note: completeness === "TRUNCATED"
          ? d.truncation_note ?? "Source manifest marks the supplied bytes TRUNCATED; cutoff cause and continuation are not established."
          : completeness === "UNKNOWN"
            ? "Completeness is UNKNOWN: source identity/ingest status does not establish COMPLETE."
            : null,
      };
    });
    const truncated = documents.filter((d) => d.completeness === "TRUNCATED");
    const unknown = documents.filter((d) => d.completeness === "UNKNOWN");
    const mismatched = documents.filter((d) => d.identity_status === "MISMATCH");
    const statusMismatch = documents.filter((d) =>
      d.identity_status === "MATCH"
      && d.ingested_truncated !== (d.manifest_completeness === "TRUNCATED"),
    );

    return NextResponse.json({
      ok: true,
      ingested: stats.documents > 0,
      last_ingest_ms: Number(brain.meta("last_ingest_ms") ?? 0) || null,
      stats,
      canonical_pack_role: "INDEX_ONLY",
      source_completeness_summary: {
        COMPLETE: documents.filter((d) => d.completeness === "COMPLETE").length,
        TRUNCATED: truncated.length,
        UNKNOWN: unknown.length,
      },
      documents,
      strategies_by_runtime: byRuntime,
      strategies_by_family: byFamily,
      limitations: [
        ...(truncated.length
          ? [`${truncated.length} supplied raw source file(s) are marked TRUNCATED by the identity-bound manifest (${truncated.map((d) => d.file_id).join(", ")}). The capture cause, continuation location and any external copies are not established; no continuation is reconstructed.`]
          : []),
        ...(unknown.length
          ? [`${unknown.length} supplied raw source file(s) have completeness UNKNOWN (${unknown.map((d) => d.file_id).join(", ")}); byte/character count or an apparently clean ending does not establish completeness.`]
          : []),
        ...(mismatched.length
          ? [`${mismatched.length} ingested source identity/byte record(s) do not match the current manifest (${mismatched.map((d) => d.file_id).join(", ")}); completeness is UNKNOWN until verified and re-ingested.`]
          : []),
        ...(statusMismatch.length
          ? [`${statusMismatch.length} ingested truncation flag(s) disagree with the current source manifest (${statusMismatch.map((d) => d.file_id).join(", ")}); completeness is UNKNOWN until re-ingested.`]
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
