/**
 * GET /api/system/config — masked config + persisted prefs (never secrets).
 * POST /api/system/config {section: risk|ai|general, ...values} — guarded;
 * values are validated and stored in DB prefs (no source-code mutation).
 */
import { NextResponse } from "next/server";
import { maskedConfig } from "@/lib/env";
import { getRepo } from "@/db/sqlite";
import { guardMutation, readBody } from "@/lib/api-common";
import { getProductionRiskPolicy, riskPolicyEligibility, selectableRiskPolicies } from "@/lib/risk/policy";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const repo = getRepo();
  const prefs: Record<string, string> = {};
  for (const key of ["risk.equity", "risk.perTradePct", "risk.maxLeverage", "risk.policyId", "ai.provider", "general.language"]) {
    const value = repo.configGet(`pref.${key}`);
    if (value !== null) prefs[key] = value;
  }
  const policies = selectableRiskPolicies();
  return NextResponse.json({
    ok: true,
    env: maskedConfig(),
    prefs,
    risk_policy: getProductionRiskPolicy(),
    risk_policy_options: policies.map((policy) => ({ ...policy, eligibility: riskPolicyEligibility(policy) })),
    note: "credentials are masked; explicit risk selection is required; CONFLICT, inferred, or incomplete-source policies remain blocked",
  });
}

type ParsedBound = number | null | "INVALID" | "OMITTED";
const parseBounded = (value: unknown, lo: number, hi: number): ParsedBound => {
  if (value === undefined) return "OMITTED";
  if (value === null) return null;
  let numeric: number;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) numeric = Number(value);
  else return "INVALID";
  return Number.isFinite(numeric) && numeric >= lo && numeric <= hi ? numeric : "INVALID";
};

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const repo = getRepo();
  const section = body.section;

  if (section === "risk") {
    const equity = parseBounded(body.equity, 1, 1e9);
    const perTrade = parseBounded(body.perTradePct, 0.1, 50);
    const maxLeverage = parseBounded(body.maxLeverage, 1, 50);
    if (equity === "INVALID" || perTrade === "INVALID" || maxLeverage === "INVALID") {
      return NextResponse.json({ ok: false, error: "equity must be 1..1e9, perTradePct 0.1..50, maxLeverage 1..50; send null to clear a value" }, { status: 400 });
    }

    let requestedPolicy: string | null | undefined;
    if (body.policyId === null || body.policyId === "") requestedPolicy = null;
    else if (body.policyId !== undefined) {
      if (typeof body.policyId !== "string") return NextResponse.json({ ok: false, error: "policyId must be a registered string or null" }, { status: 400 });
      requestedPolicy = body.policyId.trim();
      const policy = selectableRiskPolicies().find((candidate) => candidate.policy_id === requestedPolicy);
      if (!policy) return NextResponse.json({ ok: false, error: `unknown risk policy '${requestedPolicy}'` }, { status: 400 });
      const eligibility = riskPolicyEligibility(policy);
      if (!eligibility.selectable) {
        return NextResponse.json({ ok: false, error: `risk policy '${requestedPolicy}' is not selectable`, reasons: eligibility.reasons }, { status: 409 });
      }
    }

    // Validate the entire request before one atomic preference update.
    repo.withTransaction(() => {
      if (equity !== "OMITTED") repo.configSet("pref.risk.equity", equity === null ? "UNCONFIGURED" : String(equity));
      if (perTrade !== "OMITTED") repo.configSet("pref.risk.perTradePct", perTrade === null ? "UNCONFIGURED" : String(perTrade));
      if (maxLeverage !== "OMITTED") repo.configSet("pref.risk.maxLeverage", maxLeverage === null ? "UNCONFIGURED" : String(maxLeverage));
      if (requestedPolicy !== undefined) repo.configSet("pref.risk.policyId", requestedPolicy ?? "UNSELECTED");
    });

    const applied: Record<string, number | string | null> = {};
    if (equity !== "OMITTED") applied.equity = equity;
    if (perTrade !== "OMITTED") applied.perTradePct = perTrade;
    if (maxLeverage !== "OMITTED") applied.maxLeverage = maxLeverage;
    if (requestedPolicy !== undefined) applied.policyId = requestedPolicy;
    return NextResponse.json({ ok: true, section, applied, note: "null clears a sizing input; null policyId explicitly removes the selection. No automatic defaults are applied." });
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
