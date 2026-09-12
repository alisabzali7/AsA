/**
 * GET /api/system/config — masked config + persisted prefs (never secrets).
 * POST /api/system/config {section: risk|ai|general, ...values} — guarded;
 * values are clamped and stored in DB prefs (no source-code mutation).
 */
import { NextResponse } from "next/server";
import { maskedConfig } from "@/lib/env";
import { getRepo } from "@/db/sqlite";
import { guardMutation, readBody } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const repo = getRepo();
  const prefs: Record<string, string> = {};
  for (const k of ["risk.equity", "risk.perTradePct", "risk.maxLeverage", "ai.provider", "general.language"]) {
    const v = repo.configGet(`pref.${k}`);
    if (v !== null) prefs[k] = v;
  }
  return NextResponse.json({ ok: true, env: maskedConfig(), prefs, note: "masked: credential rows show CONFIGURED/NOT_CONFIGURED only" });
}

const clampNum = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const repo = getRepo();
  const section = body.section;
  if (section === "risk") {
    const equity = clampNum(body.equity, 1, 1e9);
    const perTrade = clampNum(body.perTradePct, 0.1, 50);
    const maxLev = clampNum(body.maxLeverage, 1, 50);
    if (equity !== null) repo.configSet("pref.risk.equity", String(equity));
    if (perTrade !== null) repo.configSet("pref.risk.perTradePct", String(perTrade));
    if (maxLev !== null) repo.configSet("pref.risk.maxLeverage", String(maxLev));
    return NextResponse.json({ ok: true, section, applied: { equity, perTradePct: perTrade, maxLeverage: maxLev } });
  }
  if (section === "ai") {
    const provider = body.provider;
    if (provider === "auto" || provider === "heuristic" || provider === "ollama" || provider === "openai") {
      repo.configSet("pref.ai.provider", provider);
      return NextResponse.json({ ok: true, section, applied: { provider } });
    }
    return NextResponse.json({ ok: false, error: "provider must be auto|heuristic|ollama|openai" }, { status: 400 });
  }
  if (section === "general") {
    if (body.language === "en" || body.language === "fa") repo.configSet("pref.general.language", body.language);
    return NextResponse.json({ ok: true, section });
  }
  return NextResponse.json({ ok: false, error: "section must be risk|ai|general" }, { status: 400 });
}
