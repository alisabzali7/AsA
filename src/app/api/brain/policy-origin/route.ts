/**
 * GET /api/brain/policy-origin — which numbers came from the corpus and which
 * are AsA engineering choices (remediation P1-§9).
 */
import { NextResponse } from "next/server";
import { POLICY_PARAMS, policiesByOrigin, validatePolicyOrigins, ENGINEERING_POLICY_VERSION } from "@/lib/policy/origin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const byOrigin = policiesByOrigin();
  const validation = validatePolicyOrigins();
  return NextResponse.json({
    ok: validation.ok,
    engineering_policy_version: ENGINEERING_POLICY_VERSION,
    counts: Object.fromEntries(Object.entries(byOrigin).map(([k, v]) => [k, v.length])),
    params: POLICY_PARAMS,
    validation,
    note: "an ENGINEERING_POLICY value is an AsA implementation choice and is never presented as an instructor rule; a SOURCE_VERIFIED value always carries a corpus citation",
    ts: Date.now(),
  });
}
