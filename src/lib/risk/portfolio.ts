/**
 * Deterministic portfolio risk gate. Unknown exposure or measurements remain
 * UNKNOWN; only measured zero is represented by numeric zero.
 */
import type { RiskPolicy } from "../brain/types";

export interface OpenRisk {
  symbol: string;
  /** risk still at stake if the stop is hit, in account currency; null is UNKNOWN */
  risk_amount: number | null;
  direction: "long" | "short";
}

export interface PortfolioInput {
  equity: number | null;
  policy: RiskPolicy;
  /** null = the book itself is unavailable; null risk_amount = that row's exposure is unknown. */
  open_risks: OpenRisk[] | null;
  daily_realized_loss: number | null;
  period_realized_loss: number | null;
  candidate: { symbol: string; risk_amount: number | null; direction: "long" | "short" };
  correlation_groups?: Record<string, string>;
  max_per_group?: number;
}

export interface PortfolioLine {
  label: string;
  value: number | string | null;
  unit: string;
  limit: number | null;
  ok: boolean;
  note?: string;
}

export interface PortfolioOutput {
  verdict: "pass" | "block" | "unknown";
  reasons: string[];
  blocked_by: string[];
  lines: PortfolioLine[];
  numbers: {
    equity: number | null;
    open_risk_total: number | null;
    portfolio_heat_pct: number | null;
    heat_after_candidate_pct: number | null;
    daily_loss_used_pct: number | null;
    period_loss_used_pct: number | null;
    remaining_daily_budget: number | null;
    concurrent_positions: number | null;
    group_exposure: Record<string, number | null>;
  };
  unenforced: string[];
}

const pct = (part: number, whole: number | null): number | null =>
  whole !== null && Number.isFinite(whole) && whole > 0 && Number.isFinite(part) ? (part / whole) * 100 : null;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const isKnownRisk = (risk: number | null): risk is number =>
  typeof risk === "number" && Number.isFinite(risk) && risk >= 0;

export function evaluatePortfolio(input: PortfolioInput): PortfolioOutput {
  const equity = input.equity !== null && Number.isFinite(input.equity) && input.equity > 0 ? input.equity : null;
  const { policy, candidate } = input;
  const lines: PortfolioLine[] = [];
  const blocked: string[] = [];
  const unknowns: string[] = [];
  const reasons: string[] = [];
  const unenforced: string[] = [];

  if (equity === null) unknowns.push("account equity unavailable or invalid — portfolio risk percentages cannot be evaluated");
  if (policy.selection_status !== "SELECTED") blocked.push(`risk policy ${policy.policy_id} is not explicitly selected (${policy.selection_status ?? "UNSELECTED"})`);
  if (policy.runtime_status === "DISABLED" || policy.source_status !== "SOURCE_VERIFIED" || policy.source_refs.length === 0 || policy.conflict_group_id !== null) {
    blocked.push(`risk policy ${policy.policy_id} is not source-verified and usable (${policy.source_status}/${policy.runtime_status})`);
  }

  const bookAvailable = input.open_risks !== null;
  const openRisks = input.open_risks ?? [];
  const exposureKnown = bookAvailable && openRisks.every((risk) => isKnownRisk(risk.risk_amount));
  if (!bookAvailable) unknowns.push("open advisory book UNAVAILABLE — not assumed empty");
  else if (!exposureKnown) unknowns.push("open advisory book contains UNKNOWN risk notional — not converted to zero");

  const candidateRiskKnown = isKnownRisk(candidate.risk_amount);
  const candidateRisk = candidateRiskKnown ? candidate.risk_amount : null;
  if (!candidateRiskKnown) unknowns.push("candidate risk amount UNAVAILABLE — not converted to zero");

  const openTotal = exposureKnown ? openRisks.reduce((sum, risk) => sum + (risk.risk_amount as number), 0) : null;
  const heat = openTotal === null ? null : pct(openTotal, equity);
  const heatAfter = openTotal === null || candidateRisk === null ? null : pct(openTotal + candidateRisk, equity);
  const dailyLoss = input.daily_realized_loss !== null && Number.isFinite(input.daily_realized_loss) && input.daily_realized_loss >= 0 ? input.daily_realized_loss : null;
  const periodLoss = input.period_realized_loss !== null && Number.isFinite(input.period_realized_loss) && input.period_realized_loss >= 0 ? input.period_realized_loss : null;
  if (input.daily_realized_loss !== null && dailyLoss === null) unknowns.push("daily realized loss measurement is invalid");
  if (input.period_realized_loss !== null && periodLoss === null) unknowns.push("period realized loss measurement is invalid");
  const dailyUsed = dailyLoss === null ? null : pct(dailyLoss, equity);
  const periodUsed = periodLoss === null ? null : pct(periodLoss, equity);

  lines.push({ label: "Account equity", value: equity === null ? null : r2(equity), unit: "quote", limit: null, ok: equity !== null, note: equity === null ? "UNKNOWN" : undefined });
  lines.push({ label: "Open risk (sum at stop)", value: openTotal === null ? null : r2(openTotal), unit: "quote", limit: null, ok: openTotal !== null, note: openTotal === null ? "UNKNOWN — exposure is not zero" : undefined });
  lines.push({ label: "Candidate risk", value: candidateRisk === null ? null : r2(candidateRisk), unit: "quote", limit: null, ok: candidateRisk !== null, note: candidateRisk === null ? "UNKNOWN — not zero" : undefined });

  if (policy.risk_per_trade_pct !== null) {
    if (candidateRisk === null || equity === null) {
      unknowns.push("candidate risk amount or account equity UNKNOWN — selected per-trade limit cannot be evaluated");
      lines.push({ label: "Risk per trade", value: null, unit: "%", limit: policy.risk_per_trade_pct, ok: false, note: "UNKNOWN" });
    } else {
      const actualPct = pct(candidateRisk, equity);
      const ok = actualPct !== null && candidateRisk <= equity * policy.risk_per_trade_pct / 100 * 1.01;
      lines.push({ label: "Risk per trade", value: actualPct === null ? null : r2(actualPct), unit: "%", limit: policy.risk_per_trade_pct, ok, note: `policy ${policy.policy_id}` });
      if (!ok) blocked.push(`candidate risk ${actualPct === null ? "UNKNOWN" : `${r2(actualPct)}%`} exceeds policy per-trade limit ${policy.risk_per_trade_pct}%`);
    }
  } else {
    unenforced.push("risk_per_trade_pct not specified by the selected source-backed policy");
  }

  if (policy.max_account_risk_pct !== null) {
    if (heatAfter === null) {
      unknowns.push("portfolio heat UNKNOWN (equity, open exposure, or candidate notional missing)");
      lines.push({ label: "Portfolio heat after entry", value: null, unit: "%", limit: policy.max_account_risk_pct, ok: false, note: "UNKNOWN" });
    } else {
      const ok = heatAfter <= policy.max_account_risk_pct;
      lines.push({ label: "Portfolio heat after entry", value: r2(heatAfter), unit: "%", limit: policy.max_account_risk_pct, ok });
      if (!ok) blocked.push(`portfolio heat would reach ${r2(heatAfter)}%, exceeding the ${policy.max_account_risk_pct}% account-risk ceiling`);
    }
  } else {
    unenforced.push("max_account_risk_pct not specified by the selected policy");
    lines.push({ label: "Portfolio heat after entry", value: heatAfter === null ? null : r2(heatAfter), unit: "%", limit: null, ok: heatAfter !== null, note: heatAfter === null ? "UNKNOWN" : undefined });
  }

  let remainingDaily: number | null = null;
  if (policy.daily_loss_limit_pct !== null) {
    if (dailyLoss === null || equity === null) {
      unknowns.push("daily realized loss or account equity UNKNOWN — selected daily limit cannot be evaluated");
      lines.push({ label: "Daily loss used", value: null, unit: "%", limit: policy.daily_loss_limit_pct, ok: false, note: "UNKNOWN" });
    } else {
      const budget = equity * policy.daily_loss_limit_pct / 100;
      remainingDaily = Math.max(0, budget - dailyLoss);
      const exhausted = dailyLoss >= budget;
      if (candidateRisk === null) unknowns.push("candidate risk amount UNKNOWN — daily budget cannot evaluate this entry");
      const wouldExceed = candidateRisk !== null && dailyLoss + candidateRisk > budget;
      lines.push({ label: "Daily loss used", value: dailyUsed === null ? null : r2(dailyUsed), unit: "%", limit: policy.daily_loss_limit_pct, ok: !exhausted && dailyUsed !== null });
      lines.push({ label: "Remaining daily risk budget", value: r2(remainingDaily), unit: "quote", limit: null, ok: !exhausted });
      if (exhausted) blocked.push(`daily loss limit reached (${dailyUsed === null ? "UNKNOWN" : `${r2(dailyUsed)}%`} of ${policy.daily_loss_limit_pct}%)`);
      else if (wouldExceed) blocked.push(`this trade's risk would push today's loss past the ${policy.daily_loss_limit_pct}% daily limit`);
    }
  } else {
    unenforced.push("daily_loss_limit_pct not specified by the selected policy");
  }

  if (policy.period_loss_limit_pct !== null) {
    if (periodUsed === null) {
      unknowns.push("period realized loss or account equity UNKNOWN — selected period limit cannot be evaluated");
      lines.push({ label: "Period loss used", value: null, unit: "%", limit: policy.period_loss_limit_pct, ok: false, note: "UNKNOWN" });
    } else {
      const ok = periodUsed < policy.period_loss_limit_pct;
      lines.push({ label: "Period loss used", value: r2(periodUsed), unit: "%", limit: policy.period_loss_limit_pct, ok });
      if (!ok) blocked.push(`period loss ${r2(periodUsed)}% has reached the ${policy.period_loss_limit_pct}% ceiling`);
    }
  } else {
    unenforced.push("period_loss_limit_pct not specified by the selected policy");
  }

  const concurrent = bookAvailable ? openRisks.length : null;
  if (policy.max_concurrent_positions !== null) {
    if (concurrent === null) {
      unknowns.push("open advisory book UNKNOWN — selected concurrency limit cannot be evaluated");
      lines.push({ label: "Concurrent positions", value: null, unit: "count", limit: policy.max_concurrent_positions, ok: false, note: "UNKNOWN" });
    } else {
      const ok = concurrent < policy.max_concurrent_positions;
      lines.push({ label: "Concurrent positions", value: concurrent, unit: "count", limit: policy.max_concurrent_positions, ok });
      if (!ok) blocked.push(`already holding ${concurrent} positions, at the ${policy.max_concurrent_positions} concurrency limit`);
    }
  } else {
    unenforced.push("max_concurrent_positions not specified by the selected policy");
    lines.push({ label: "Concurrent positions", value: concurrent, unit: "count", limit: null, ok: concurrent !== null, note: concurrent === null ? "UNKNOWN" : undefined });
  }

  const groups = input.correlation_groups ?? {};
  const groupExposure: Record<string, number | null> = {};
  if (bookAvailable) {
    for (const risk of openRisks) {
      const group = groups[risk.symbol] ?? "ungrouped";
      if (!isKnownRisk(risk.risk_amount)) groupExposure[group] = null;
      else if (groupExposure[group] !== null) groupExposure[group] = (groupExposure[group] ?? 0) + risk.risk_amount;
      else if (!(group in groupExposure)) groupExposure[group] = risk.risk_amount;
    }
    const candidateGroup = groups[candidate.symbol] ?? "ungrouped";
    if (input.max_per_group !== undefined && candidateGroup !== "ungrouped") {
      const existing = candidateGroup in groupExposure ? groupExposure[candidateGroup] : 0;
      if (existing === null || candidateRisk === null) {
        unknowns.push(`correlated exposure for ${candidateGroup} is UNKNOWN`);
        lines.push({ label: `Correlated exposure (${candidateGroup})`, value: null, unit: "quote", limit: input.max_per_group, ok: false, note: "UNKNOWN" });
      } else {
        const total = existing + candidateRisk;
        const ok = total <= input.max_per_group;
        lines.push({ label: `Correlated exposure (${candidateGroup})`, value: r2(total), unit: "quote", limit: input.max_per_group, ok });
        if (!ok) blocked.push(`correlated group '${candidateGroup}' exposure ${r2(total)} exceeds ${input.max_per_group}`);
      }
    } else if (candidateGroup === "ungrouped") {
      unenforced.push(`no correlation group mapped for ${candidate.symbol} — operator mapping not configured`);
    }

    const sameSymbol = openRisks.filter((risk) => risk.symbol === candidate.symbol);
    if (sameSymbol.length > 0) {
      const opposing = sameSymbol.some((risk) => risk.direction !== candidate.direction);
      lines.push({ label: `Existing exposure in ${candidate.symbol}`, value: sameSymbol.length, unit: "positions", limit: null, ok: !opposing, note: opposing ? "opposing direction already open" : undefined });
      if (opposing) blocked.push(`an opposing ${sameSymbol[0].direction} position in ${candidate.symbol} is already open`);
    }
  } else {
    unknowns.push("open advisory book UNKNOWN — duplicate-symbol and correlation checks cannot be evaluated");
  }

  if (blocked.length === 0 && unknowns.length === 0) {
    reasons.push("portfolio checks passed");
    if (unenforced.length > 0) reasons.push(`${unenforced.length} policy dimensions are not specified by the selected policy`);
  }
  return {
    verdict: blocked.length > 0 ? "block" : unknowns.length > 0 ? "unknown" : "pass",
    reasons: [...reasons, ...blocked, ...unknowns],
    blocked_by: [...blocked, ...unknowns],
    lines,
    numbers: {
      equity: equity === null ? null : r2(equity),
      open_risk_total: openTotal === null ? null : r2(openTotal),
      portfolio_heat_pct: heat === null ? null : r2(heat),
      heat_after_candidate_pct: heatAfter === null ? null : r2(heatAfter),
      daily_loss_used_pct: dailyUsed === null ? null : r2(dailyUsed),
      period_loss_used_pct: periodUsed === null ? null : r2(periodUsed),
      remaining_daily_budget: remainingDaily === null ? null : r2(remainingDaily),
      concurrent_positions: concurrent,
      group_exposure: Object.fromEntries(Object.entries(groupExposure).map(([key, value]) => [key, value === null ? null : r2(value)])),
    },
    unenforced: [...unenforced, ...unknowns],
  };
}
