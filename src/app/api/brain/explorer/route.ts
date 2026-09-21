/**
 * GET /api/brain/explorer — the Knowledge Explorer.
 *
 *   ?strategy=STR-…    full dossier: canonical interpretation, per-field source
 *                      labels, exact source quotes, conflicts, unknowns, status
 *   ?file=1.txt&line=586[&radius=6]   raw source window with provenance
 *   ?q=…               full-text search across every ingested line
 *
 * This is the surface that answers "what did AsA learn, and from which line?".
 */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";
import { gateStrategy } from "@/lib/brain/gate";
import type { CompiledSpec } from "@/lib/brain/compile";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const brain = getBrain();
    const strategyId = url.searchParams.get("strategy");
    const file = url.searchParams.get("file");
    const q = url.searchParams.get("q");

    /* ---------------------------------------------- raw source window view */
    if (file) {
      const line = Number(url.searchParams.get("line") ?? 1);
      const radius = Math.min(60, Math.max(0, Number(url.searchParams.get("radius") ?? 6)));
      const frags = brain.fragmentsFor(file, line, radius);
      return NextResponse.json({
        ok: true,
        mode: "source_window",
        file,
        line,
        radius,
        fragments: frags.map((f) => ({
          line: f.start_line,
          text: f.raw_text,
          class: f.fragment_class,
          tags: f.topic_tags,
          quarantined: f.quarantined,
          quarantine_reason: f.quarantine_reason,
        })),
        ts: Date.now(),
      });
    }

    /* --------------------------------------------------------- text search */
    if (q) {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      const hits = brain.searchFragments(q, limit);
      return NextResponse.json({
        ok: true,
        mode: "search",
        query: q,
        hits: hits.map((f) => ({
          file: f.file_id,
          line: f.start_line,
          text: f.raw_text.slice(0, 600),
          class: f.fragment_class,
          tags: f.topic_tags,
          quarantined: f.quarantined,
        })),
        count: hits.length,
        note: "search covers every ingested source line, including quarantined commentary (marked)",
        ts: Date.now(),
      });
    }

    /* ------------------------------------------------------ strategy dossier */
    if (strategyId) {
      const s = brain.strategy(strategyId);
      if (!s) return NextResponse.json({ ok: false, error: `unknown strategy ${strategyId}` }, { status: 404 });

      const compiled: CompiledSpec[] = JSON.parse(brain.meta("compiled_specs_full") ?? "[]") as CompiledSpec[];
      const spec = compiled.find((c) => c.strategy_id === strategyId) ?? null;
      // Canonical conflict input: the linked group's RESOLUTION decides, never
      // the mere presence of the link (see `brain/conflicts.ts`).
      const verdict = gateStrategy(s, brain.conflicts());

      // attach the verbatim source line behind every referenced location
      const quotes = s.source_refs.slice(0, 12).flatMap((r) =>
        brain.fragmentsFor(r.file, r.start_line, 0).map((f) => ({
          file: r.file,
          line: f.start_line,
          text: f.raw_text,
          class: f.fragment_class,
        })),
      );

      // per-field provenance: value + its own source label + exact line
      const fields = spec
        ? Object.entries(spec.field_status).map(([field, label]) => ({
            field,
            source_label: label,
            line: spec.field_lines[field] ?? null,
            value:
              (spec as unknown as Record<string, unknown>)[field] === undefined
                ? null
                : ((spec as unknown as Record<string, unknown>)[field] as string | null),
          }))
        : [];

      const conflicts = s.conflict_group_id
        ? brain.conflicts().filter((c) => c.conflict_group_id === s.conflict_group_id)
        : [];

      return NextResponse.json({
        ok: true,
        mode: "strategy",
        strategy: {
          strategy_id: s.strategy_id,
          canonical_name: s.canonical_name,
          family: s.family,
          aliases: s.aliases,
          description: s.description,
          source_status: s.source_status,
          empirical_status: s.empirical_status,
          runtime_status: s.runtime_status,
          runtime_ceiling: verdict.ceiling,
          why_this_status: verdict.reasons,
          unknown_critical: s.unknown_critical,
          version: s.version,
        },
        executable_spec: spec
          ? {
              executable: spec.executable,
              blocked_because: spec.blocked_because,
              timeframe: spec.timeframe,
              entry_long: spec.entry_long,
              entry_short: spec.entry_short,
              prerequisites: spec.prerequisites,
              confirmation: spec.confirmation,
              stop: spec.stop,
              target: spec.target,
              exit: spec.exit,
              filters: spec.filters,
              exclusions: spec.exclusions,
            }
          : null,
        field_provenance: fields,
        source_quotes: quotes,
        conflicts,
        note:
          "field source_label distinguishes what the instructor stated explicitly (VERIFIED) from what the extraction inferred (INFERRED) and what was never stated (UNKNOWN)",
        ts: Date.now(),
      });
    }

    /* ------------------------------------------------------------- default */
    return NextResponse.json({
      ok: true,
      mode: "index",
      usage: {
        strategy: "/api/brain/explorer?strategy=STR-RAW-2-581",
        source_window: "/api/brain/explorer?file=1.txt&line=586&radius=6",
        search: "/api/brain/explorer?q=PRZ&limit=20",
      },
      stats: brain.stats(),
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:ingest`" },
      { status: 503 },
    );
  }
}
