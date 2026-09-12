/** GET /api/system/health — process + TTT + boot phase (docs §deployment). */
import { NextResponse } from "next/server";
import { isBooted, bootError } from "@/lib/state";
import { marketEngine } from "@/lib/market/engine";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (bootError()) {
    return NextResponse.json({ ok: false, error: bootError(), market: "ERROR", booted: false }, { status: 503 });
  }
  const health = marketEngine.computeHealth();
  const ok = health.market === "LIVE" || health.market === "STALE" || (!isBooted() && health.market === "CONNECTING");
  return NextResponse.json({
    ok,
    booted: isBooted(),
    market: health.market,
    reason: health.reason,
    ts: Date.now(),
  });
}
