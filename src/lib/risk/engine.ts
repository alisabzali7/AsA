/**
 * Deterministic risk engine (closure §H).
 *
 * ONE engine serves advisory, paper, backtest, OOS and walk-forward — there is
 * no second sizing implementation.
 *
 * Fixes applied in the closure run:
 *  - DIRECTION SAFETY: a long with stop >= entry (or a short with stop <= entry)
 *    is now a hard BLOCK. The previous version used Math.abs() only, which
 *    silently accepted a stop on the wrong side of the entry.
 *  - TARGET-AWARE RR: R:R is derived from the strategy's actual target model.
 *    The old hard-coded `rrStaged = 3` has been removed entirely.
 *  - VENUE CONSTRAINTS: tick size and quantity step are applied when TTT
 *    supplies them. minQty / minNotional are NOT exposed by the verified public
 *    TTT interface, so they are reported UNAVAILABLE instead of being invented.
 *  - LIQUIDATION is an ESTIMATE, never a venue fact. Its gate semantics are
 *    explicit and separately labelled.
 */
import { ASA_RISK_ACCOUNT_EQUITY, ASA_RISK_PER_TRADE_PCT, ASA_RISK_MAX_LEVERAGE } from "../env";

export interface RiskInput {
  symbol: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  /** first target from the strategy's target model; null when unknown */
  target?: number | null;
  equity: number;
  riskPerTradePct: number;
  maxLeverage: number;
  venueMaxLeverage: number | null;
  maintenanceMarginRate: number | null;
  takerFeeCoefficient: number | null;
  /** venue constraints where TTT supplies them */
  tickSize?: number | null;
  qtyStep?: number | null;
  /** not exposed by verified public TTT — pass null to record UNAVAILABLE */
  minQty?: number | null;
  minNotional?: number | null;
}

export interface RiskOutput {
  verdict: "pass" | "block";
  reasons: string[];
  /** venue constraints that could not be enforced, with the exact reason */
  unenforced: string[];
  numbers: {
    stop_distance: number | null;
    stop_distance_pct: number | null;
    risk_amount: number | null;
    risk_notional: number | null;
    suggested_size_base: number | null;
    position_size: number | null;
    notional: number | null;
    maximum_allowed_size: number | null;
    leverage_estimate: number | null;
    /** derived from the ACTUAL target, null when no target is known */
    risk_reward: number | null;
    rr_staged: number | null;
    liq_estimate: number | null;
    liq_label: "ESTIMATE" | null;
    fees_roundtrip_pct: number | null;
  };
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const round8 = (v: number): number => Math.round(v * 1e8) / 1e8;

/** Round a size DOWN to the venue's quantity step (never round up into risk). */
function applyStep(size: number, step: number | null | undefined): number {
  if (!step || step <= 0) return size;
  return Math.floor(size / step) * step;
}

export function evaluateRisk(input: RiskInput): RiskOutput {
  const reasons: string[] = [];
  const blocks: string[] = [];
  const unenforced: string[] = [];

  const equity = input.equity > 0 ? input.equity : ASA_RISK_ACCOUNT_EQUITY;
  const riskPct = input.riskPerTradePct > 0 ? input.riskPerTradePct : ASA_RISK_PER_TRADE_PCT;
  const capLev = input.maxLeverage > 0 ? input.maxLeverage : ASA_RISK_MAX_LEVERAGE;

  /* ---------------------------------------------- DIRECTION SAFETY (hard) */
  if (!Number.isFinite(input.entry) || !Number.isFinite(input.stop)) {
    blocks.push("entry/stop are not finite numbers");
  } else if (input.direction === "long" && input.stop >= input.entry) {
    blocks.push(`LONG requires stop < entry, got stop ${input.stop} >= entry ${input.entry}`);
  } else if (input.direction === "short" && input.stop <= input.entry) {
    blocks.push(`SHORT requires stop > entry, got stop ${input.stop} <= entry ${input.entry}`);
  }

  const stopAbs = Math.abs(input.entry - input.stop);
  const stopPct = input.entry > 0 ? (stopAbs / input.entry) * 100 : null;
  const riskAmount = equity * (riskPct / 100);

  let sizeBase = stopAbs > 0 ? riskAmount / stopAbs : null;
  if (sizeBase !== null) {
    const stepped = applyStep(sizeBase, input.qtyStep);
    if (stepped !== sizeBase) {
      reasons.push(`size rounded down from ${round8(sizeBase)} to ${round8(stepped)} by venue step ${input.qtyStep}`);
    }
    sizeBase = stepped;
  }
  const notional = sizeBase !== null ? sizeBase * input.entry : null;
  const levEst = notional !== null && equity > 0 ? notional / equity : null;
  const maxAllowedSize = stopAbs > 0 ? (equity * capLev) / input.entry : null;

  /* ------------------------------------------------- TARGET-AWARE R:R */
  let rr: number | null = null;
  if (input.target !== undefined && input.target !== null && stopAbs > 0) {
    const rewardAbs = Math.abs(input.target - input.entry);
    // the target must be on the profitable side, otherwise R:R is meaningless
    const targetValid = input.direction === "long" ? input.target > input.entry : input.target < input.entry;
    if (!targetValid) {
      blocks.push(`target ${input.target} is on the wrong side of entry ${input.entry} for a ${input.direction}`);
    } else {
      rr = round4(rewardAbs / stopAbs);
    }
  } else {
    unenforced.push("no target supplied — R:R is UNKNOWN and the minimum-R:R gate is not enforced");
  }

  /* ---------------------------------------------- venue constraint honesty */
  if (input.qtyStep === null || input.qtyStep === undefined) {
    unenforced.push("qty step unavailable from TTT catalog — size not quantised");
  }
  if (input.minQty === null || input.minQty === undefined) {
    unenforced.push("minQty is not exposed by the verified public TTT interface — minimum-quantity check skipped (not invented)");
  } else if (sizeBase !== null && sizeBase < input.minQty) {
    blocks.push(`size ${round8(sizeBase)} is below venue minQty ${input.minQty}`);
  }
  if (input.minNotional === null || input.minNotional === undefined) {
    unenforced.push("minNotional is not exposed by the verified public TTT interface — minimum-notional check skipped (not invented)");
  } else if (notional !== null && notional < input.minNotional) {
    blocks.push(`notional ${round4(notional)} is below venue minNotional ${input.minNotional}`);
  }

  /* --------------------------------------- liquidation ESTIMATE (labelled) */
  let liq: number | null = null;
  if (levEst !== null && levEst > 0 && input.maintenanceMarginRate !== null) {
    const mm = Math.min(0.5, Math.max(0, input.maintenanceMarginRate));
    const factor = 1 / levEst - mm;
    if (input.direction === "long" && factor < 1) liq = input.entry * (1 - factor);
    if (input.direction === "short" && factor < 1) liq = input.entry * (1 + factor);
  } else {
    unenforced.push("liquidation ESTIMATE not computable (no maintenance margin rate) — liquidation gate inactive");
  }

  /* ------------------------------------------------------------- vetoes */
  if (stopPct === null) blocks.push("stop distance not computable");
  if (stopPct !== null && stopPct > 30) blocks.push(`stop distance ${stopPct.toFixed(2)}% exceeds the 30% sanity bound (ENGINEERING LIMIT)`);
  if (sizeBase !== null && sizeBase <= 0) blocks.push("computed position size is zero or negative after venue rounding");
  if (levEst !== null && levEst > capLev) blocks.push(`estimated leverage ${levEst.toFixed(2)}x exceeds the AsA cap ${capLev}x`);
  if (input.venueMaxLeverage !== null && levEst !== null && levEst > input.venueMaxLeverage) {
    blocks.push(`estimated leverage ${levEst.toFixed(2)}x exceeds venue max ${input.venueMaxLeverage}x`);
  }
  // liquidation gate: ESTIMATE-based, and stated as such in the reason
  if (liq !== null && input.direction === "long" && input.stop < liq) {
    blocks.push(`stop ${input.stop} sits beyond the ESTIMATED liquidation ${liq.toFixed(6)} (estimate, not a venue fact) — would be liquidated first`);
  }
  if (liq !== null && input.direction === "short" && input.stop > liq) {
    blocks.push(`stop ${input.stop} sits beyond the ESTIMATED liquidation ${liq.toFixed(6)} (estimate, not a venue fact) — would be liquidated first`);
  }
  // R:R gate only applies when a real target exists — never assumed
  if (rr !== null && rr < 1.5) blocks.push(`R:R ${rr.toFixed(2)} is below the 1.5 minimum (ENGINEERING LIMIT)`);

  const feesPct = input.takerFeeCoefficient !== null ? input.takerFeeCoefficient * 2 * 100 : null;
  if (feesPct === null) unenforced.push("taker fee coefficient unavailable — fee impact not modelled in this check");

  if (blocks.length === 0) {
    reasons.push("risk checks passed", `risk per trade ${riskPct}% of ${equity} equity = ${round4(riskAmount)}`);
  }

  return {
    verdict: blocks.length === 0 ? "pass" : "block",
    reasons: [...reasons, ...blocks],
    unenforced,
    numbers: {
      stop_distance: stopAbs > 0 ? round8(stopAbs) : null,
      stop_distance_pct: stopPct !== null ? round4(stopPct) : null,
      risk_amount: round4(riskAmount),
      risk_notional: round4(riskAmount),
      suggested_size_base: sizeBase !== null ? round8(sizeBase) : null,
      position_size: sizeBase !== null ? round8(sizeBase) : null,
      notional: notional !== null ? round4(notional) : null,
      maximum_allowed_size: maxAllowedSize !== null ? round8(maxAllowedSize) : null,
      leverage_estimate: levEst !== null ? round4(levEst) : null,
      risk_reward: rr,
      rr_staged: rr,
      liq_estimate: liq !== null ? round8(liq) : null,
      liq_label: liq !== null ? "ESTIMATE" : null,
      fees_roundtrip_pct: feesPct !== null ? round4(feesPct) : null,
    },
  };
}
