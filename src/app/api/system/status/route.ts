/** GET /api/system/status — full observability (no secrets ever). */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { marketEngine } from "@/lib/market/engine";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* boot may fail when TTT is down; still report partial status */
  }
  const status = await marketEngine.status();
  return NextResponse.json({ ok: true, ...status });
}
