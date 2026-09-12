/**
 * Stage 4 — portfolio-level risk governance layered on the per-trade engine.
 *
 * The per-trade engine (`risk/engine.ts`) answers "is this ONE trade sized
 * correctly?". This module answers "given everything else already open today,
 * may this trade exist at all?" — portfolio heat, daily loss budget,
 * concurrency, correlation and concentration.
 *
 * Policy numbers come from the BRAIN (corpus-derived, operator-selected), never
 * from hard-coded constants, so the disputed risk percentages stay adjudicable.
 * Every output is fully itemized so the UI can show the arithmetic.
 */
import type { RiskPolicy } from "../brain/types";

export interface OpenRisk {
  symbol: string;
  /** risk still at stake if the stop is hit, in account currency */
  risk_amount: number;
  direction: "long" | "short";
}

export interface PortfolioInput {
  equity: number;
  policy: RiskPolicy;
  /** currently open advisory positions the user reported holding */
  open_risks: OpenRisk[];
  /** realized loss so far today, positive number in account currency */
  daily_realized_loss: number;
  /** realized loss over the policy period, positive number */
  period_realized_loss: number;
  /** the candidate trade being evaluated */
  candidate: { symbol: string; risk_amount: number; direction: "long" | "short" };
  /** correlation groups, e.g. majors vs memes; symbol -> group id */
  correlation_groups?: Record<string, string>;
  max_per_group?: number;
}

export interface PortfolioLine {
  label: string;
  value: number | string | null;
  unit: string;
  /** null when this line is informational rather than a limit */
  limit: number | null;
  ok: boolean;
  note?: string;
}

export interface PortfolioOutput {
  verdict: "pass" | "block";
  reasons: string[];
  blocked_by: string[];
  lines: PortfolioLine[];
  numbers: {
    equity: number;
    open_risk_total: number;
    portfolio_heat_pct: number;
    heat_after_candidate_pct: number;
    daily_loss_used_pct: number;
    period_loss_used_pct: number;
    remaining_daily_budget: number | null;
    concurrent_positions: number;
    group_exposure: Record<string, number>;
  };
  /** policy fields the corpus never specified — checks skipped, said out loud */
  unenforced: string[];
}

const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Evaluate portfolio-level constraints. A null policy field means the corpus
 * never stated that limit: the check is SKIPPED and listed in `unenforced`
 * rather than silently defaulted to an invented number.
 */
export function evaluatePortfolio(input: PortfolioInput): PortfolioOutput {
  const { equity, policy, open_risks, candidate } = input;
  const lines: PortfolioLine[] = [];
  const blocked: string[] = [];
  const reasons: string[] = [];
  const unenforced: string[] = [];

  const openTotal = open_risks.reduce((a, o) => a + Math.max(0, o.risk_amount), 0);
  const heat = pct(openTotal, equity);
  const heatAfter = pct(openTotal + Math.max(0, candidate.risk_amount), equity);
  const dailyUsed = pct(input.daily_realized_loss, equity);
  const periodUsed = pct(input.period_realized_loss, equity);

  lines.push({ label: "Account equity", value: r2(equity), unit: "quote", limit: null, ok: true });
  lines.push({ label: "Open risk (sum at stop)", value: r2(openTotal), unit: "quote", limit: null, ok: true });
  lines.push({ label: "Candidate risk", value: r2(candidate.risk_amount), unit: "quote", limit: null, ok: true });

  /* --------------------------------------------------- per-trade risk size */
  if (policy.risk_per_trade_pct !== null) {
    const allowed = equity * (policy.risk_per_trade_pct / 100);
    // 1% tolerance for rounding in size calculations
    const ok = candidate.risk_amount <= allowed * 1.01;
    lines.push({
      label: "Risk per trade",
      value: r2(pct(candidate.risk_amount, equity)),
      unit: "%",
      limit: policy.risk_per_trade_pct,
      ok,
      note: `policy ${policy.policy_id}`,
    });
    if (!ok) {
      blocked.push(
        `candidate risk ${r2(pct(candidate.risk_amount, equity))}% exceeds policy per-trade limit ${policy.risk_per_trade_pct}%`,
      );
    }
  } else {
    unenforced.push("risk_per_trade_pct not specified by the selected policy — per-trade size check skipped");
  }

  /* ------------------------------------------------------- portfolio heat */
  if (policy.max_account_risk_pct !== null) {
    const ok = heatAfter <= policy.max_account_risk_pct;
    lines.push({
      label: "Portfolio heat after entry",
      value: r2(heatAfter),
      unit: "%",
      limit: policy.max_account_risk_pct,
      ok,
    });
    if (!ok) {
      blocked.push(
        `portfolio heat would reach ${r2(heatAfter)}%, exceeding the ${policy.max_account_risk_pct}% account-risk ceiling`,
      );
    }
  } else {
    unenforced.push("max_account_risk_pct not specified — portfolio heat ceiling not enforced");
    lines.push({ label: "Portfolio heat after entry", value: r2(heatAfter), unit: "%", limit: null, ok: true });
  }

  /* ----------------------------------------------------- daily loss budget */
  let remainingDaily: number | null = null;
  if (policy.daily_loss_limit_pct !== null) {
    const budget = equity * (policy.daily_loss_limit_pct / 100);
    remainingDaily = Math.max(0, budget - input.daily_realized_loss);
    const exhausted = input.daily_realized_loss >= budget;
    const wouldExceed = input.daily_realized_loss + candidate.risk_amount > budget;
    lines.push({
      label: "Daily loss used",
      value: r2(dailyUsed),
      unit: "%",
      limit: policy.daily_loss_limit_pct,
      ok: !exhausted,
    });
    lines.push({
      label: "Remaining daily risk budget",
      value: r2(remainingDaily),
      unit: "quote",
      limit: null,
      ok: !exhausted,
    });
    if (exhausted) {
      blocked.push(
        `daily loss limit reached (${r2(dailyUsed)}% of ${policy.daily_loss_limit_pct}%) — no further advisory entries today`,
      );
    } else if (wouldExceed) {
      blocked.push(
        `this trade's risk would push today's loss past the ${policy.daily_loss_limit_pct}% daily limit`,
      );
    }
  } else {
    unenforced.push("daily_loss_limit_pct not specified — daily loss stop not enforced");
  }

  /* ---------------------------------------------------- period drawdown */
  if (policy.period_loss_limit_pct !== null) {
    const ok = periodUsed < policy.period_loss_limit_pct;
    lines.push({
      label: "Period loss used",
      value: r2(periodUsed),
      unit: "%",
      limit: policy.period_loss_limit_pct,
      ok,
    });
    if (!ok) blocked.push(`period loss ${r2(periodUsed)}% has reached the ${policy.period_loss_limit_pct}% ceiling`);
  } else {
    unenforced.push("period_loss_limit_pct not specified — period drawdown ceiling not enforced");
  }

  /* ------------------------------------------------------ concurrency */
  const concurrent = open_risks.length;
  if (policy.max_concurrent_positions !== null) {
    const ok = concurrent < policy.max_concurrent_positions;
    lines.push({
      label: "Concurrent positions",
      value: concurrent,
      unit: "count",
      limit: policy.max_concurrent_positions,
      ok,
    });
    if (!ok) {
      blocked.push(`already holding ${concurrent} positions, at the ${policy.max_concurrent_positions} concurrency limit`);
    }
  } else {
    unenforced.push("max_concurrent_positions not specified — concurrency not enforced");
    lines.push({ label: "Concurrent positions", value: concurrent, unit: "count", limit: null, ok: true });
  }

  /* -------------------------------------------- correlation / concentration */
  const groups = input.correlation_groups ?? {};
  const groupExposure: Record<string, number> = {};
  for (const o of open_risks) {
    const g = groups[o.symbol] ?? "ungrouped";
    groupExposure[g] = (groupExposure[g] ?? 0) + o.risk_amount;
  }
  const candGroup = groups[candidate.symbol] ?? "ungrouped";
  const candGroupAfter = (groupExposure[candGroup] ?? 0) + candidate.risk_amount;
  if (input.max_per_group !== undefined && candGroup !== "ungrouped") {
    const ok = candGroupAfter <= input.max_per_group;
    lines.push({
      label: `Correlated exposure (${candGroup})`,
      value: r2(candGroupAfter),
      unit: "quote",
      limit: input.max_per_group,
      ok,
    });
    if (!ok) blocked.push(`correlated group '${candGroup}' exposure ${r2(candGroupAfter)} exceeds ${input.max_per_group}`);
  } else if (candGroup === "ungrouped") {
    unenforced.push(
      `no correlation group mapped for ${candidate.symbol} — correlation limit not enforced (mapping is operator-supplied, not derived from the corpus)`,
    );
  }

  // duplicate-symbol concentration is always checked (deterministic, no policy needed)
  const sameSymbol = open_risks.filter((o) => o.symbol === candidate.symbol);
  if (sameSymbol.length > 0) {
    const opposing = sameSymbol.some((o) => o.direction !== candidate.direction);
    lines.push({
      label: `Existing exposure in ${candidate.symbol}`,
      value: sameSymbol.length,
      unit: "positions",
      limit: null,
      ok: !opposing,
      note: opposing ? "opposing direction already open" : undefined,
    });
    if (opposing) {
      blocked.push(`an opposing ${sameSymbol[0].direction} position in ${candidate.symbol} is already open — hedged/conflicting advisory suppressed`);
    }
  }

  if (blocked.length === 0) {
    reasons.push("portfolio checks passed");
    if (unenforced.length > 0) reasons.push(`${unenforced.length} check(s) skipped because the policy does not specify them`);
  }

  return {
    verdict: blocked.length === 0 ? "pass" : "block",
    reasons: [...reasons, ...blocked],
    blocked_by: blocked,
    lines,
    numbers: {
      equity: r2(equity),
      open_risk_total: r2(openTotal),
      portfolio_heat_pct: r2(heat),
      heat_after_candidate_pct: r2(heatAfter),
      daily_loss_used_pct: r2(dailyUsed),
      period_loss_used_pct: r2(periodUsed),
      remaining_daily_budget: remainingDaily === null ? null : r2(remainingDaily),
      concurrent_positions: concurrent,
      group_exposure: Object.fromEntries(Object.entries(groupExposure).map(([k, v]) => [k, r2(v)])),
    },
    unenforced,
  };
}
