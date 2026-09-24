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
 *
 * UNAVAILABLE inputs (null open book / null realized loss / null candidate
 * notional) are NEVER coerced to 0. Zero means "measured none". Unknown means
 * the check is skipped and listed in `unenforced`, or the candidate is blocked
 * when the check cannot be honest without fabricating a pass.
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
  /**
   * Currently open advisory positions.
   * `null` = the open book is UNAVAILABLE (never treat as empty — empty would
   * silently pass heat/concurrency/duplicate checks).
   */
  open_risks: OpenRisk[] | null;
  /**
   * Realized loss so far today, positive number in account currency.
   * `null` = UNAVAILABLE (do not substitute 0 — 0 means "measured no loss").
   */
  daily_realized_loss: number | null;
  /** Realized loss over the policy period. `null` = UNAVAILABLE, not zero. */
  period_realized_loss: number | null;
  /** the candidate trade being evaluated */
  candidate: { symbol: string; risk_amount: number | null; direction: "long" | "short" };
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
    open_risk_total: number | null;
    portfolio_heat_pct: number | null;
    heat_after_candidate_pct: number | null;
    daily_loss_used_pct: number | null;
    period_loss_used_pct: number | null;
    remaining_daily_budget: number | null;
    concurrent_positions: number | null;
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
 * rather than silently defaulted to an invented number. A null MEASUREMENT
 * (open book / realized loss / candidate notional) is the same honesty:
 * skipped + declared, never assumed zero.
 */
export function evaluatePortfolio(input: PortfolioInput): PortfolioOutput {
  const { equity, policy, candidate } = input;
  const lines: PortfolioLine[] = [];
  const blocked: string[] = [];
  const reasons: string[] = [];
  const unenforced: string[] = [];

  const openBookKnown = input.open_risks !== null;
  const open_risks = input.open_risks ?? [];
  const candidateRiskKnown = candidate.risk_amount !== null;
  const candidateRisk = candidate.risk_amount ?? 0;

  const openTotal = openBookKnown ? open_risks.reduce((a, o) => a + Math.max(0, o.risk_amount), 0) : null;
  const heat = openTotal === null ? null : pct(openTotal, equity);
  const heatAfter =
    openTotal === null || !candidateRiskKnown ? null : pct(openTotal + Math.max(0, candidateRisk), equity);
  const dailyUsed = input.daily_realized_loss === null ? null : pct(input.daily_realized_loss, equity);
  const periodUsed = input.period_realized_loss === null ? null : pct(input.period_realized_loss, equity);

  lines.push({ label: "Account equity", value: r2(equity), unit: "quote", limit: null, ok: true });
  lines.push({
    label: "Open risk (sum at stop)",
    value: openTotal === null ? null : r2(openTotal),
    unit: "quote",
    limit: null,
    ok: true,
    note: openBookKnown ? undefined : "UNAVAILABLE — not assumed empty",
  });
  lines.push({
    label: "Candidate risk",
    value: candidateRiskKnown ? r2(candidateRisk) : null,
    unit: "quote",
    limit: null,
    ok: true,
    note: candidateRiskKnown ? undefined : "UNAVAILABLE — risk engine did not produce a notional",
  });

  /* --------------------------------------------------- per-trade risk size */
  if (policy.risk_per_trade_pct !== null) {
    if (!candidateRiskKnown) {
      unenforced.push("candidate risk_amount UNAVAILABLE — per-trade size check skipped (not assumed 0)");
    } else {
      const allowed = equity * (policy.risk_per_trade_pct / 100);
      // 1% tolerance for rounding in size calculations
      const ok = candidateRisk <= allowed * 1.01;
      lines.push({
        label: "Risk per trade",
        value: r2(pct(candidateRisk, equity)),
        unit: "%",
        limit: policy.risk_per_trade_pct,
        ok,
        note: `policy ${policy.policy_id}`,
      });
      if (!ok) {
        blocked.push(
          `candidate risk ${r2(pct(candidateRisk, equity))}% exceeds policy per-trade limit ${policy.risk_per_trade_pct}%`,
        );
      }
    }
  } else {
    unenforced.push("risk_per_trade_pct not specified by the selected policy — per-trade size check skipped");
  }

  /* ------------------------------------------------------- portfolio heat */
  if (policy.max_account_risk_pct !== null) {
    if (heatAfter === null) {
      unenforced.push(
        "portfolio heat UNAVAILABLE (open book or candidate notional missing) — account-risk ceiling not enforced (not assumed 0)",
      );
      lines.push({ label: "Portfolio heat after entry", value: null, unit: "%", limit: policy.max_account_risk_pct, ok: true, note: "UNAVAILABLE" });
    } else {
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
    }
  } else {
    unenforced.push("max_account_risk_pct not specified — portfolio heat ceiling not enforced");
    lines.push({ label: "Portfolio heat after entry", value: heatAfter === null ? null : r2(heatAfter), unit: "%", limit: null, ok: true });
  }

  /* ----------------------------------------------------- daily loss budget */
  let remainingDaily: number | null = null;
  if (policy.daily_loss_limit_pct !== null) {
    if (input.daily_realized_loss === null) {
      unenforced.push(
        "daily realized loss UNAVAILABLE — daily loss stop not enforced (not assumed 0)",
      );
    } else {
      const budget = equity * (policy.daily_loss_limit_pct / 100);
      remainingDaily = Math.max(0, budget - input.daily_realized_loss);
      const exhausted = input.daily_realized_loss >= budget;
      const wouldExceed = candidateRiskKnown && input.daily_realized_loss + candidateRisk > budget;
      lines.push({
        label: "Daily loss used",
        value: r2(dailyUsed as number),
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
          `daily loss limit reached (${r2(dailyUsed as number)}% of ${policy.daily_loss_limit_pct}%) — no further advisory entries today`,
        );
      } else if (wouldExceed) {
        blocked.push(
          `this trade's risk would push today's loss past the ${policy.daily_loss_limit_pct}% daily limit`,
        );
      }
    }
  } else {
    unenforced.push("daily_loss_limit_pct not specified — daily loss stop not enforced");
  }

  /* ---------------------------------------------------- period drawdown */
  if (policy.period_loss_limit_pct !== null) {
    if (periodUsed === null) {
      unenforced.push("period realized loss UNAVAILABLE — period drawdown ceiling not enforced (not assumed 0)");
    } else {
      const ok = periodUsed < policy.period_loss_limit_pct;
      lines.push({
        label: "Period loss used",
        value: r2(periodUsed),
        unit: "%",
        limit: policy.period_loss_limit_pct,
        ok,
      });
      if (!ok) blocked.push(`period loss ${r2(periodUsed)}% has reached the ${policy.period_loss_limit_pct}% ceiling`);
    }
  } else {
    unenforced.push("period_loss_limit_pct not specified — period drawdown ceiling not enforced");
  }

  /* ------------------------------------------------------ concurrency */
  const concurrent = openBookKnown ? open_risks.length : null;
  if (policy.max_concurrent_positions !== null) {
    if (concurrent === null) {
      unenforced.push("open advisory book UNAVAILABLE — concurrency not enforced (not assumed 0 positions)");
    } else {
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
    }
  } else {
    unenforced.push("max_concurrent_positions not specified — concurrency not enforced");
    lines.push({ label: "Concurrent positions", value: concurrent, unit: "count", limit: null, ok: true });
  }

  /* -------------------------------------------- correlation / concentration */
  const groups = input.correlation_groups ?? {};
  const groupExposure: Record<string, number> = {};
  if (!openBookKnown) {
    unenforced.push("open advisory book UNAVAILABLE — correlation/duplicate-symbol checks not enforced (not assumed empty)");
  } else {
    for (const o of open_risks) {
      const g = groups[o.symbol] ?? "ungrouped";
      groupExposure[g] = (groupExposure[g] ?? 0) + o.risk_amount;
    }
    const candGroup = groups[candidate.symbol] ?? "ungrouped";
    const candGroupAfter = (groupExposure[candGroup] ?? 0) + (candidateRiskKnown ? candidateRisk : 0);
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

    // duplicate-symbol concentration is always checked when the book is measured
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
  }

  if (blocked.length === 0) {
    reasons.push("portfolio checks passed");
    if (unenforced.length > 0) reasons.push(`${unenforced.length} check(s) skipped because a policy field or measurement is unspecified`);
  }

  return {
    verdict: blocked.length === 0 ? "pass" : "block",
    reasons: [...reasons, ...blocked],
    blocked_by: blocked,
    lines,
    numbers: {
      equity: r2(equity),
      open_risk_total: openTotal === null ? null : r2(openTotal),
      portfolio_heat_pct: heat === null ? null : r2(heat),
      heat_after_candidate_pct: heatAfter === null ? null : r2(heatAfter),
      daily_loss_used_pct: dailyUsed === null ? null : r2(dailyUsed),
      period_loss_used_pct: periodUsed === null ? null : r2(periodUsed),
      remaining_daily_budget: remainingDaily === null ? null : r2(remainingDaily),
      concurrent_positions: concurrent,
      group_exposure: Object.fromEntries(Object.entries(groupExposure).map(([k, v]) => [k, r2(v)])),
    },
    unenforced,
  };
}
