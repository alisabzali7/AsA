/** GET /api/psychology/summary?symbol= — market psychology + separate source-only user material. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { buildPsychology } from "@/lib/psychology/engine";
import { USER_PSYCHOLOGY_SOURCE_RULES, USER_PSYCHOLOGY_SOURCES } from "@/lib/psychology/user-source";
import { getBrain } from "@/lib/brain/store";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try { await ensureEngineBooted(); } catch { /* market context remains explicitly degraded */ }
  const url = new URL(req.url);
  const { symbol, error } = sym(url.searchParams, "symbol", "BTCUSDT");
  if (error) return error;
  const summary = buildPsychology(symbol as string);
  let userPsychologySource: Record<string, unknown>;
  try {
    const brain = getBrain();
    const records = brain.psychologyPrinciples();
    const manifestStatus = brain.meta("source_recovery_manifest_status") ?? "UNKNOWN";
    userPsychologySource = {
      status: records.length === USER_PSYCHOLOGY_SOURCE_RULES.length ? manifestStatus : "UNKNOWN",
      sources: USER_PSYCHOLOGY_SOURCES,
      principles: records,
      principle_definitions: USER_PSYCHOLOGY_SOURCE_RULES,
      source_manifest_sha256: brain.meta("source_recovery_manifest_sha256"),
      semantic_status: "NOT_PROVEN",
      runtime_status: "DISABLED",
      user_traits_inferred: false,
      note: "This is source-only descriptive material, not an assessment of this user's traits and not an executable gate. Market psychology above describes measured market context, not user state.",
    };
  } catch (err) {
    userPsychologySource = {
      status: "UNKNOWN",
      sources: USER_PSYCHOLOGY_SOURCES,
      principles: [],
      semantic_status: "NOT_PROVEN",
      runtime_status: "DISABLED",
      user_traits_inferred: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return NextResponse.json({ ok: true, ...summary, user_psychology_source: userPsychologySource });
}
