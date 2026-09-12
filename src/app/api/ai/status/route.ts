/** GET /api/ai/status — measured provider statuses (never claims online). */
import { NextResponse } from "next/server";
import { providerStatuses } from "@/lib/ai";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const providers = await providerStatuses();
  return NextResponse.json({
    ok: true,
    providers,
    note: "heuristic = deterministic evidence assembly, NOT an LLM; LLM providers show online only after a real probe",
    ts: Date.now(),
  });
}
