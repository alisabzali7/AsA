/** GET/POST /api/market/focus — read focus symbol; POST switches it (mutation-guarded). */
import { NextResponse } from "next/server";
import { sharedStore } from "@/lib/market/store";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, symbol: sharedStore.focusSymbol, ts: Date.now() });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const raw = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!isOperationalSymbol(raw)) {
    return NextResponse.json({ ok: false, error: `'${raw}' is not in the operational TTT universe` }, { status: 400 });
  }
  sharedStore.setFocus(raw);
  return NextResponse.json({ ok: true, symbol: raw });
}
