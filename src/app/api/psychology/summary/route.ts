/** GET /api/psychology/summary?symbol= — explainable psychology engine. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { buildPsychology } from "@/lib/psychology/engine";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded */
  }
  const url = new URL(req.url);
  const { symbol, error } = sym(url.searchParams, "symbol", "BTCUSDT");
  if (error) return error;
  const summary = buildPsychology(symbol as string);
  return NextResponse.json({ ok: true, ...summary });
}
