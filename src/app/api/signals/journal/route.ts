/** /api/signals/journal — manual journal (GET list, POST add). */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const rows = getRepo().journalList().map((j) => ({ ...j }));
  return NextResponse.json({ ok: true, items: rows, count: rows.length, note: "R multiple is auto-recorded from your entry — it is self-reported, not venue-verified" });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  if (!isOperationalSymbol(symbol)) return NextResponse.json({ ok: false, error: "symbol not in the operational TTT universe" }, { status: 400 });
  const direction = body.direction === "long" || body.direction === "short" ? body.direction : null;
  if (!direction) return NextResponse.json({ ok: false, error: "direction long|short required" }, { status: 400 });
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 2000) : "";
  const rRaw = body.r_multiple;
  const r = typeof rRaw === "number" && Number.isFinite(rRaw) ? Math.min(10, Math.max(-10, rRaw)) : null;
  const id = getRepo().journalAdd({ created_ms: Date.now(), updated_ms: Date.now(), symbol, direction, notes, opp_id: typeof body.opp_id === "string" ? body.opp_id.slice(0, 64) : null, r_multiple: r });
  return NextResponse.json({ ok: true, id });
}
