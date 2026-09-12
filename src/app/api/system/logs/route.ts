/** GET /api/system/logs — recent engine errors + retention audit runs. */
import { NextResponse } from "next/server";
import { sharedStore } from "@/lib/market/store";
import { getRepo } from "@/db/sqlite";
import type { RetentionRunRow } from "@/db/repo";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  let retention: RetentionRunRow[] = [];
  try { retention = getRepo().retentionRuns(20); } catch { /* db not ready */ }
  return NextResponse.json({
    ok: true,
    errors: sharedStore.tttErrors.slice(-30),
    retention_runs: retention,
    ts: Date.now(),
  });
}
