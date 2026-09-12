/** GET /api/research/ai-calls — audit trail (provider, latency, verdict). */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const rows = getRepo().aiCallList(100);
  return NextResponse.json({ ok: true, count: rows.length, items: rows, note: "structured outputs only; no chain-of-thought is stored" });
}
