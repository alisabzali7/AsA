/** GET/POST /api/market/focus — read focus symbol; POST switches it (mutation-guarded). */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol, universeMeta } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try { await ensureEngineBooted(); } catch { /* state reported below */ }
  return NextResponse.json({ ok: true, symbol: sharedStore.focusSymbol, universe: universeMeta(), ts: Date.now() });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const raw = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!isOperationalSymbol(raw)) {
    const meta = universeMeta();
    return NextResponse.json(
      { ok: false, error: `'${raw}' is not in the operational TTT universe`, universe: meta },
      { status: meta.discovery_complete ? 400 : 503 },
    );
  }
  sharedStore.setFocus(raw);
  return NextResponse.json({ ok: true, symbol: raw });
}
