/**
 * POST /api/ai-clone {question, symbol?} — grounded assistant.
 * Answers are assembled from live deterministic state with explicit tags:
 * FACT (measured), RULE (system rule), INTERPRETATION (derived), HYPOTHESIS
 * (reasoning), UNAVAILABLE. No LLM is simulated: when no LLM provider is
 * configured the answer says so and stays evidence-based.
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";
import { buildPsychology } from "@/lib/psychology/engine";
import { providerStatuses } from "@/lib/ai";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 2000) : "";
  if (!question) return NextResponse.json({ ok: false, error: "question is required" }, { status: 400 });
  const rawSym = typeof body.symbol === "string" ? body.symbol.toUpperCase() : null;
  const symbol = rawSym && isOperationalSymbol(rawSym) ? rawSym : null;
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded */
  }
  const providers = await providerStatuses();
  const llmOnline = providers.some((p) => p.online === true && p.id !== "heuristic");

  const q = question.toLowerCase();
  const facts: string[] = [];
  const tags: string[] = [];

  if (symbol) {
    const stats = sharedStore.getStats(symbol);
    const truth = (m: string) => sharedStore.metricTruth(symbol, m);
    facts.push(`FACT: ${symbol} last price = ${stats?.lastPrice ?? "unavailable"} (source ttt /futures/markets/stats)`);
    facts.push(`FACT: funding rate = ${stats?.fundingRate ?? "unavailable"}`);
    if (truth("liquidations").verdict === "UNAVAILABLE") facts.push(`UNAVAILABLE: liquidation data does not exist on the verified public TTT interface — ${truth("liquidations").reason}`);
    if (truth("cvd").verdict === "UNAVAILABLE") facts.push(`UNAVAILABLE: CVD is not computed — taker-side semantics are unverified (${truth("cvd").reason})`);
    const psych = buildPsychology(symbol);
    facts.push(`RULE: psychology bias = ${psych.bias} — ${psych.bias_reason}`);
    const cov = [...sharedStore.coverage.values()].filter((c) => c.symbol === symbol);
    if (cov.length) facts.push(`FACT: history coverage for ${symbol}: ${cov.map((c) => `${c.timeframe}=${c.bar_count}b`).join(", ")}`);
  } else {
    const live = sharedStore.liveSymbolCount();
    facts.push(`FACT: board live ${live.live}/${live.total} universe symbols (source ttt stats sweep)`);
    facts.push(`FACT: stats sweep age ${sharedStore.lastStatsSweepAtMs === null ? "never" : `${Math.round((Date.now() - sharedStore.lastStatsSweepAtMs) / 1000)}s`}`);
  }
  if (/ton/i.test(question)) facts.push("RULE: TONUSDT is excluded from the AsA universe by definition — it will never appear in the board or analysis.");
  if (/probability|certainty|٪|درصد/.test(question)) facts.push("RULE: AsA scores are deterministic scores, never calibrated probabilities. No probability claim is made without a calibration system.");
  if (/execute|order|buy|sell|trade now|سفارش|خرید|فروش/.test(question)) facts.push("RULE: AsA is advisory-only. It never places, cancels or modifies orders, and has no execution client. You execute on your venue account.");
  if (/strategy|استراتژی/.test(question)) facts.push("FACT: the ~300-page personal strategy is not yet formalized; the pluggable StrategyDefinition interface is ready and ReferenceStrategy exists for structural tests only (liveEligible=false).");

  if (facts.length === 0) {
    facts.push(`UNAVAILABLE: the question "${question.slice(0, 80)}" does not map to measured AsA evidence. Ask about a symbol, metrics, coverage, funding, risk, or strategy state.`);
  }
  tags.push(llmOnline ? "grounded on live state (LLM provider online)" : "grounded on live state · HEURISTIC ASSEMBLY (no LLM provider configured)");
  return NextResponse.json({ ok: true, question, symbol, answer: facts, tags, llm_online: llmOnline, ts: Date.now() });
}
