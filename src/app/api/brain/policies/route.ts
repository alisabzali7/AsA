/** GET /api/brain/policies — source-bound policies, psychology records, and conflicts. */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";
import { getProductionRiskPolicy, riskPolicyEligibility, selectableRiskPolicies } from "@/lib/risk/policy";
import {
  USER_PSYCHOLOGY_SECTIONS,
  USER_PSYCHOLOGY_SOURCES,
  USER_PSYCHOLOGY_SOURCE_RULES,
} from "@/lib/psychology/user-source";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const b = getBrain();
    let sourceManifest: unknown = null;
    try { sourceManifest = JSON.parse(b.meta("source_recovery_manifest") ?? "null"); } catch { sourceManifest = null; }
    const psychologyPrinciples = b.psychologyPrinciples();
    const policyCatalog = selectableRiskPolicies();
    return NextResponse.json({
      ok: true,
      risk_policy: getProductionRiskPolicy(),
      risk_policy_options: policyCatalog.map((policy) => ({ ...policy, eligibility: riskPolicyEligibility(policy) })),
      risk_policies: b.riskPolicies(),
      psychology_policies: b.psychologyPolicies(),
      psychology_source_pack: {
        sources: USER_PSYCHOLOGY_SOURCES,
        sections: USER_PSYCHOLOGY_SECTIONS,
        source_only_rules: USER_PSYCHOLOGY_SOURCE_RULES,
        ingested_records: psychologyPrinciples,
        source_manifest: sourceManifest,
        source_manifest_sha256: b.meta("source_recovery_manifest_sha256"),
        source_manifest_status: b.meta("source_recovery_manifest_status") ?? "UNKNOWN",
        runtime_authority: "NONE — these source-only paraphrase records do not assert user traits and are not executable gates",
      },
      conflicts: b.conflicts(),
      conflict_history: b.conflictHistory(),
      note: "risk-policy selection and psychology activation require complete cited source artifacts; exact quotes from TRUNCATED or UNKNOWN sources remain inactive, and unresolved conflicts stay separate",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:ingest`" },
      { status: 503 },
    );
  }
}
