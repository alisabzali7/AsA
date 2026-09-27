/** GET /api/ai/status — measured provider status and persisted selection. */
import { NextResponse } from "next/server";
import { providerStatuses } from "@/lib/ai";
import { getAiProviderPref } from "@/lib/prefs";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [providers, provider_mode] = await Promise.all([providerStatuses(), Promise.resolve(getAiProviderPref())]);
  return NextResponse.json({
    ok: true,
    provider_mode,
    providers,
    note: "heuristic = deterministic evidence assembly, NOT an LLM; LLM providers show online only after a real probe; auto resolves local then cloud, while an explicit provider preference does not silently switch providers",
    ts: Date.now(),
  });
}
