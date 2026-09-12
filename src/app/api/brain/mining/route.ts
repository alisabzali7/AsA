/**
 * GET /api/brain/mining — deep-mining inventory (§B4, §P).
 *
 * Reports the knowledge graph derived from narrative text, with strategy
 * counts separated by ORIGIN so process/psychology/security concepts are never
 * counted as strategies.
 */
import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import { ASA_BRAIN_DB_PATH } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const role = url.searchParams.get("role");
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  let db: Database.Database | null = null;
  try {
    db = new Database(ASA_BRAIN_DB_PATH, { readonly: true });
    const all = <T>(q: string, ...a: unknown[]): T[] => db!.prepare(q).all(...a) as T[];
    const grp = (t: string, c: string) =>
      Object.fromEntries(all<{ k: string; n: number }>(`SELECT ${c} k, COUNT(*) n FROM ${t} GROUP BY 1 ORDER BY n DESC`).map((r) => [r.k, r.n]));

    const atomsByKind = grp("knowledge_atoms", "kind");
    const atomsBySem = grp("knowledge_atoms", "semantic_status");
    const one = <T>(q: string): T => db!.prepare(q).get() as T;

    // §B4: strategy counts reported SEPARATELY, never conflated
    const explicitSource = one<{ n: number }>("SELECT COUNT(*) n FROM strategies WHERE implementation IS NOT NULL").n;
    const brainStrategies = one<{ n: number }>("SELECT COUNT(*) n FROM strategies").n;
    const generated = one<{ n: number }>("SELECT COUNT(*) n FROM strategy_candidates").n;

    return NextResponse.json({
      ok: true,
      corpus: {
        fragments: one<{ n: number }>("SELECT COUNT(*) n FROM source_fragments").n,
        atoms: one<{ n: number }>("SELECT COUNT(*) n FROM knowledge_atoms").n,
      },
      atoms: {
        by_kind: atomsByKind,
        by_semantic_status: atomsBySem,
        computable: atomsBySem.EXPLICIT_COMPUTABLE ?? 0,
      },
      components: {
        total: one<{ n: number }>("SELECT COUNT(*) n FROM strategy_components").n,
        by_role: grp("strategy_components", "role"),
        computable: one<{ n: number }>("SELECT COUNT(*) n FROM strategy_components WHERE computable=1").n,
      },
      strategy_counts: {
        explicit_source_strategy_count: explicitSource,
        brain_strategy_records: brainStrategies,
        source_derived_strategy_count: 0,
        candidate_strategy_count: generated,
        disabled_strategy_count:
          one<{ n: number }>("SELECT COUNT(*) n FROM strategies WHERE runtime_status='DISABLED'").n +
          one<{ n: number }>("SELECT COUNT(*) n FROM strategy_candidates WHERE runtime_status='DISABLED'").n,
        process_count: atomsByKind.PROCESS ?? 0,
        psychology_count: atomsByKind.PSYCHOLOGY ?? 0,
        risk_policy_count: one<{ n: number }>("SELECT COUNT(*) n FROM risk_policies").n,
        security_count: atomsByKind.SECURITY ?? 0,
        note: "process/psychology/security atoms are NOT strategies and are never counted as such",
      },
      uncertainty: {
        claim_atoms: atomsBySem.CLAIM ?? 0,
        conflict_atoms: atomsBySem.CONFLICT ?? 0,
        unknown_atoms: atomsBySem.UNKNOWN ?? 0,
        inferred_atoms: atomsBySem.INFERRED ?? 0,
      },
      sample_atoms: all(
        `SELECT atom_id, file_id, line, kind, semantic_status, source_status, concepts, direction, non_computable_reason, substr(text,1,300) text
         FROM knowledge_atoms ${kind ? "WHERE kind = ?" : ""} ORDER BY line LIMIT ?`,
        ...(kind ? [kind, limit] : [limit]),
      ),
      sample_components: all(
        `SELECT component_id, role, label, concepts, timeframes, direction, computable, occurrences, non_computable_reason
         FROM strategy_components ${role ? "WHERE role = ?" : ""} ORDER BY occurrences DESC LIMIT ?`,
        ...(role ? [role, limit] : [limit]),
      ),
      candidates: all(
        `SELECT strategy_id, name, origin, source_status, semantic_status, empirical_status, runtime_status,
                required_concepts, timeframes, direction, missing_fields, rationale, disabled_reason,
                generation_method, generation_version
         FROM strategy_candidates ORDER BY strategy_id LIMIT ?`, limit),
      governance: [
        "generated composites are ENGINE_GENERATED and can never be SOURCE_VERIFIED",
        "every candidate starts UNTESTED and is DISABLED unless all critical fields are computable",
        "qualitative source wording stays NON_COMPUTABLE — no number is ever invented",
      ],
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:mine`" },
      { status: 503 },
    );
  } finally {
    db?.close();
  }
}
