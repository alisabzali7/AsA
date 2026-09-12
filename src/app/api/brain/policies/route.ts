/**
 * GET /api/brain/policies — risk + psychology policy registries and conflicts.
 * Competing risk variants are returned intact so the UI can show that the
 * corpus disagrees rather than presenting a single invented number.
 */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const b = getBrain();
    return NextResponse.json({
      ok: true,
      risk_policies: b.riskPolicies(),
      psychology_policies: b.psychologyPolicies(),
      conflicts: b.conflicts(),
      note: "conflicting source risk percentages are preserved as separate CANDIDATE policies — never averaged, never silently chosen",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:ingest`" },
      { status: 503 },
    );
  }
}
