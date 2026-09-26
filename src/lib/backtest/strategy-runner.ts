/**
 * Strategy backtest runner — the ONE simulation engine (closure §L, §M, §N).
 *
 * NO-LOOKAHEAD CONTRACT:
 *  - the decision at bar i uses `candles.slice(0, i + 1)` only;
 *  - entry fills at bar i+1's OPEN (never bar i's close);
 *  - stop/target resolution walks bars forward one at a time;
 *  - same-bar stop+target ambiguity is resolved by an EXPLICIT policy.
 *
 * POSITION vs FILL (closure §M): a laddered exit is ONE position with several
 * fills. All statistics are position-level; per-fill fees and slippage are
 * charged on the actual filled notional so partial exits cannot double-count.
 *
 * Exits record absolute TIMESTAMPS, never slice-relative indexes.
 */
import type { Candle } from "../domain/types";
import { tfSeconds } from "../analysis/input";
import { evaluateCompiled, type CompiledStrategy } from "../strategy/compiled";
import { evaluateRisk } from "../risk/engine";
import { evaluatePsychologyGate, defaultPsychologyState } from "../psychology/gate";
import { buildPsychologyPolicies } from "../brain/policies";
import { scoreFromEvaluation } from "../pipeline/scoring";
import { admitOpportunity } from "../brain/score";
import type { RiskPolicy } from "../brain/types";

export type SameBarPolicy = "stop_first" | "target_first";

export interface BacktestCosts {
  /** taker fee per side, as a fraction (0.0005 = 5 bps) */
  fee_rate: number;
  /** slippage per side, as a fraction of price */
  slippage_rate: number;
}

export const DEFAULT_COSTS: BacktestCosts = {
  // ENGINEERING ASSUMPTION: the corpus states no fee/slippage model.
  fee_rate: 0.0005,
  slippage_rate: 0.0002,
};

/** One execution against a position. */
export interface FillRecord {
  kind: "entry" | "exit";
  price: number;
  qty: number;
  fee_quote: number;
  slippage_quote: number;
  ts: number;
  reason: string;
}

/** One POSITION = one trade for statistics, regardless of fill count. */
export interface PositionRecord {
  position_id: string;
  strategy_id: string;
  setup_id: string;
  symbol: string;
  direction: "long" | "short";
  signal_ts: number;
  entry_ts: number;
  entry_price: number;
  stop: number;
  targets: number[];
  qty: number;
  fills: FillRecord[];
  exit_ts: number;
  avg_exit_price: number;
  outcome: "target" | "stop" | "partial_then_stop" | "timeout";
  bars_held: number;
  risk_amount: number;
  /** R after all fees and slippage */
  r_multiple: number;
  /** R before costs */
  gross_r: number;
  fees_r: number;
  slippage_r: number;
  pnl_quote: number;
  score: number;
}

export interface BacktestMetrics {
  trade_count: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  average_r: number | null;
  expectancy_r: number | null;
  profit_factor: number | null;
  max_drawdown_r: number;
  max_drawdown_pct: number | null;
  longest_loss_streak: number;
  average_hold_bars: number | null;
  total_r: number;
  gross_total_r: number;
  return_pct: number | null;
  fee_impact_r: number;
  slippage_impact_r: number;
  /** TTT historical funding is not integrated — declared, never guessed */
  funding_impact: null;
  sufficient_sample: boolean;
}

export interface BacktestResult {
  strategy_id: string;
  setup_id: string;
  symbol: string;
  timeframe: string;
  bars: number;
  range: { from_ts: number; to_ts: number };
  positions: PositionRecord[];
  /** alias kept for older callers; identical to `positions` */
  trades: PositionRecord[];
  metrics: BacktestMetrics;
  equity_curve: { ts: number; equity: number }[];
  rejections: Record<string, number>;
  costs: BacktestCosts;
  same_bar_policy: SameBarPolicy;
  assumptions: string[];
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function computeMetrics(
  positions: PositionRecord[],
  equity: number,
  curve: { ts: number; equity: number }[] = [],
): BacktestMetrics {
  const n = positions.length;
  if (n === 0) {
    return {
      trade_count: 0, wins: 0, losses: 0, win_rate: null, average_r: null, expectancy_r: null,
      profit_factor: null, max_drawdown_r: 0, max_drawdown_pct: null, longest_loss_streak: 0,
      average_hold_bars: null, total_r: 0, gross_total_r: 0, return_pct: null,
      fee_impact_r: 0, slippage_impact_r: 0, funding_impact: null, sufficient_sample: false,
    };
  }
  const rs = positions.map((p) => p.r_multiple);
  const wins = positions.filter((p) => p.r_multiple > 0);
  const losses = positions.filter((p) => p.r_multiple <= 0);
  const grossWin = wins.reduce((a, p) => a + p.r_multiple, 0);
  const grossLoss = Math.abs(losses.reduce((a, p) => a + p.r_multiple, 0));
  const total = rs.reduce((a, b) => a + b, 0);

  let peak = 0, cum = 0, maxDd = 0, streak = 0, worst = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    if (r <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  }

  // true equity-curve drawdown in %, from the account curve rather than R sums
  let ddPct: number | null = null;
  if (curve.length > 1) {
    let ePeak = curve[0].equity, maxPct = 0;
    for (const pt of curve) {
      ePeak = Math.max(ePeak, pt.equity);
      if (ePeak > 0) maxPct = Math.max(maxPct, ((ePeak - pt.equity) / ePeak) * 100);
    }
    ddPct = Math.round(maxPct * 100) / 100;
  }

  const pnl = positions.reduce((a, p) => a + p.pnl_quote, 0);
  return {
    trade_count: n,
    wins: wins.length,
    losses: losses.length,
    win_rate: Math.round((wins.length / n) * 10000) / 100,
    average_r: r3(total / n),
    expectancy_r: r3(total / n),
    profit_factor: grossLoss > 0 ? r3(grossWin / grossLoss) : null,
    max_drawdown_r: r3(maxDd),
    max_drawdown_pct: ddPct,
    longest_loss_streak: worst,
    average_hold_bars: Math.round((positions.reduce((a, p) => a + p.bars_held, 0) / n) * 100) / 100,
    total_r: r3(total),
    gross_total_r: r3(positions.reduce((a, p) => a + p.gross_r, 0)),
    return_pct: equity > 0 ? Math.round((pnl / equity) * 10000) / 100 : null,
    fee_impact_r: r3(positions.reduce((a, p) => a + p.fees_r, 0)),
    slippage_impact_r: r3(positions.reduce((a, p) => a + p.slippage_r, 0)),
    funding_impact: null,
    sufficient_sample: n >= 30,
  };
}

export interface RunOptions {
  equity: number;
  policy: RiskPolicy;
  costs?: BacktestCosts;
  sameBarPolicy?: SameBarPolicy;
  max_hold_bars?: number;
  start_index?: number;
  end_index?: number;
  /** enforce the score-admission gate exactly as advisory does */
  scoreThreshold?: number;
}

export function runStrategyBacktest(
  strat: CompiledStrategy,
  symbol: string,
  candles: Candle[],
  opts: RunOptions,
): BacktestResult {
  const costs = opts.costs ?? DEFAULT_COSTS;
  const sameBar = opts.sameBarPolicy ?? "stop_first";
  const maxHold = opts.max_hold_bars ?? 200;
  const threshold = opts.scoreThreshold ?? 0; // 0 = record all admissible setups
  const positions: PositionRecord[] = [];
  const rejections: Record<string, number> = {};
  const curve: { ts: number; equity: number }[] = [];
  let equity = opts.equity;
  const bump = (k: string) => { rejections[k] = (rejections[k] ?? 0) + 1; };

  const psychPolicies = buildPsychologyPolicies();
  const start = Math.max(strat.min_bars, opts.start_index ?? strat.min_bars);
  const end = Math.min(candles.length - 2, opts.end_index ?? candles.length - 2);

  const stepSec = tfSeconds(strat.timeframe);
  if (stepSec === null) throw new Error(`strategy ${strat.strategy_id}: unknown timeframe '${strat.timeframe}'`);
  let i = start;
  while (i <= end) {
    const window = candles.slice(0, i + 1); // ONLY closed bars up to the signal
    // evaluation stamp = CLOSE instant of the decision bar (when the rules
    // could first be evaluated), not its open (Task 09). Metadata only: the
    // stamp feeds no calculation (rules/engine: evaluated_at_ms).
    const decisionT = window[window.length - 1].t;
    const ev = evaluateCompiled(strat, symbol, window, (decisionT + stepSec) * 1000);

    if (ev.setup.outcome !== "PASS") { bump(`setup:${ev.setup.outcome}`); i++; continue; }

    const { entry: rawEntry, stop, targets } = ev.levels;
    if (rawEntry === null || stop === null || targets.length === 0) { bump("levels:incomplete"); i++; continue; }

    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const dir = strat.direction;
    const slipIn = entryBar.o * costs.slippage_rate;
    const entry = dir === "long" ? entryBar.o + slipIn : entryBar.o - slipIn;

    const stopOk = dir === "long" ? stop < entry : stop > entry;
    const tgtOk = dir === "long" ? targets[0] > entry : targets[0] < entry;
    if (!stopOk || !tgtOk) { bump("levels:geometry_invalid"); i++; continue; }

    // ---- SAME risk engine as advisory, now target-aware
    const risk = evaluateRisk({
      symbol, direction: dir, entry, stop, target: targets[0],
      equity, riskPerTradePct: opts.policy.risk_per_trade_pct ?? 1,
      maxLeverage: opts.policy.max_leverage ?? 5,
      venueMaxLeverage: null, maintenanceMarginRate: null,
      takerFeeCoefficient: costs.fee_rate, tickSize: null, qtyStep: null,
      minQty: null, minNotional: null,
    });
    if (risk.verdict === "block") { bump(`risk:${risk.reasons[0]?.slice(0, 40) ?? "block"}`); i++; continue; }

    const qty = risk.numbers.position_size ?? 0;
    const riskAmount = risk.numbers.risk_amount ?? 0;
    if (qty <= 0) { bump("risk:zero_size"); i++; continue; }

    // ---- SAME psychology + score + admission gates as advisory
    const psych = evaluatePsychologyGate(psychPolicies, {
      ...defaultPsychologyState(),
      daily_loss_limit_pct: opts.policy.daily_loss_limit_pct,
    });
    const contradictions = ev.setup.blocked_rules.map((id) => `rule ${id} BLOCKED`);
    const score = scoreFromEvaluation(ev, {
      riskPass: true, psychReady: psych.verdict !== "block", psychPenalty: psych.score_penalty,
      bars: window.length, stale: false, contradictions,
    });
    const admission = admitOpportunity({
      // HARD GATE: shared contract requires setup PASS (the loop already
      // skipped non-PASS setups above; this keeps the contract explicit).
      setup_verdict: ev.setup.outcome,
      score: score.score, threshold,
      data_quality_ok: true, stale: false,
      risk_verdict: "pass", portfolio_verdict: "pass",
      psychology_verdict: psych.verdict,
      strategy_runtime_status: "CANDIDATE",
      unresolved_contradiction: contradictions.length > 0,
      unknown_required_fields: [],
    });
    if (!admission.admitted) { bump(`admission:${admission.reasons[0]?.slice(0, 40)}`); i++; continue; }

    // ---- forward walk with explicit same-bar policy; ONE position, many fills
    const stopDist = Math.abs(entry - stop);
    const fills: FillRecord[] = [{
      kind: "entry", price: entry, qty,
      fee_quote: entry * qty * costs.fee_rate,
      slippage_quote: slipIn * qty,
      ts: entryBar.t, reason: "entry at next bar open",
    }];

    let qtyLeft = qty;
    const ladder = targets.slice(0, 3);
    let nextTargetIdx = 0;
    let exitIdx = -1;
    let outcome: PositionRecord["outcome"] = "timeout";
    const perTargetQty = ladder.length > 0 ? qty / ladder.length : qty;

    for (let j = i + 1; j <= Math.min(candles.length - 1, i + 1 + maxHold) && qtyLeft > 1e-12; j++) {
      const b = candles[j];
      const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
      const tgt = ladder[nextTargetIdx];
      const hitTgt = tgt !== undefined && (dir === "long" ? b.h >= tgt : b.l <= tgt);

      // AMBIGUITY: if both are touched inside one bar we cannot know the order
      // from OHLC alone. The policy decides, explicitly and consistently.
      const resolveStopFirst = hitStop && (!hitTgt || sameBar === "stop_first");

      if (resolveStopFirst) {
        const slipOut = stop * costs.slippage_rate;
        const px = dir === "long" ? stop - slipOut : stop + slipOut;
        fills.push({
          kind: "exit", price: px, qty: qtyLeft,
          fee_quote: px * qtyLeft * costs.fee_rate, slippage_quote: slipOut * qtyLeft,
          ts: b.t, reason: nextTargetIdx > 0 ? "stop after partial target(s)" : "stop",
        });
        qtyLeft = 0;
        outcome = nextTargetIdx > 0 ? "partial_then_stop" : "stop";
        exitIdx = j;
        break;
      }
      if (hitTgt && tgt !== undefined) {
        const fillQty = Math.min(qtyLeft, perTargetQty);
        const slipOut = tgt * costs.slippage_rate;
        const px = dir === "long" ? tgt - slipOut : tgt + slipOut;
        fills.push({
          kind: "exit", price: px, qty: fillQty,
          fee_quote: px * fillQty * costs.fee_rate, slippage_quote: slipOut * fillQty,
          ts: b.t, reason: `target ${nextTargetIdx + 1}`,
        });
        qtyLeft -= fillQty;
        nextTargetIdx++;
        exitIdx = j;
        if (qtyLeft <= 1e-12 || nextTargetIdx >= ladder.length) {
          if (qtyLeft > 1e-12) {
            // ladder exhausted but size remains — close at this bar's close
            const cSlip = b.c * costs.slippage_rate;
            const cPx = dir === "long" ? b.c - cSlip : b.c + cSlip;
            fills.push({
              kind: "exit", price: cPx, qty: qtyLeft,
              fee_quote: cPx * qtyLeft * costs.fee_rate, slippage_quote: cSlip * qtyLeft,
              ts: b.t, reason: "ladder exhausted",
            });
            qtyLeft = 0;
          }
          outcome = "target";
          break;
        }
      }
    }

    if (qtyLeft > 1e-12) {
      const j = Math.min(candles.length - 1, i + 1 + maxHold);
      const b = candles[j];
      const slipOut = b.c * costs.slippage_rate;
      const px = dir === "long" ? b.c - slipOut : b.c + slipOut;
      fills.push({
        kind: "exit", price: px, qty: qtyLeft,
        fee_quote: px * qtyLeft * costs.fee_rate, slippage_quote: slipOut * qtyLeft,
        ts: b.t, reason: "timeout",
      });
      exitIdx = j;
      outcome = nextTargetIdx > 0 ? "partial_then_stop" : "timeout";
      qtyLeft = 0;
    }

    // ---- position-level accounting from the fills
    const exits = fills.filter((f) => f.kind === "exit");
    const exitQty = exits.reduce((a, f) => a + f.qty, 0);
    const avgExit = exitQty > 0 ? exits.reduce((a, f) => a + f.price * f.qty, 0) / exitQty : entry;
    const grossQuote = dir === "long" ? (avgExit - entry) * exitQty : (entry - avgExit) * exitQty;
    const feeQuote = fills.reduce((a, f) => a + f.fee_quote, 0);
    const slipQuote = fills.reduce((a, f) => a + f.slippage_quote, 0);
    const netQuote = grossQuote - feeQuote;
    const rDenom = stopDist * qty;

    equity += netQuote;
    curve.push({ ts: candles[exitIdx].t, equity });

    positions.push({
      position_id: `${strat.setup_id}|${symbol}|${candles[i].t}`,
      strategy_id: strat.strategy_id, setup_id: strat.setup_id, symbol, direction: dir,
      signal_ts: candles[i].t,          // absolute timestamps, never slice indexes
      entry_ts: entryBar.t,
      entry_price: entry, stop, targets: ladder, qty, fills,
      exit_ts: candles[exitIdx].t,
      avg_exit_price: avgExit,
      outcome,
      bars_held: exitIdx - (i + 1),
      risk_amount: riskAmount,
      r_multiple: rDenom > 0 ? r3(netQuote / rDenom) : 0,
      gross_r: rDenom > 0 ? r3(grossQuote / rDenom) : 0,
      fees_r: rDenom > 0 ? r3(feeQuote / rDenom) : 0,
      slippage_r: rDenom > 0 ? r3(slipQuote / rDenom) : 0,
      pnl_quote: Math.round(netQuote * 1e6) / 1e6,
      score: score.score,
    });

    i = exitIdx + 1; // no overlapping positions per strategy/symbol
  }

  return {
    strategy_id: strat.strategy_id,
    setup_id: strat.setup_id,
    symbol,
    timeframe: strat.timeframe,
    bars: candles.length,
    range: { from_ts: candles[0]?.t ?? 0, to_ts: candles[candles.length - 1]?.t ?? 0 },
    positions,
    trades: positions,
    metrics: computeMetrics(positions, opts.equity, curve),
    equity_curve: curve,
    rejections,
    costs,
    same_bar_policy: sameBar,
    assumptions: [
      "entry fills at the NEXT bar's open after the signal bar (no same-bar entry)",
      `same-bar stop+target ambiguity resolved by policy '${sameBar}' (OHLC cannot reveal intrabar order)`,
      `fees ${costs.fee_rate * 100}% and slippage ${costs.slippage_rate * 100}% PER SIDE are ENGINEERING ASSUMPTIONS — the corpus states no cost model`,
      "a laddered exit is ONE position with multiple fills; statistics are position-level",
      "one position at a time per strategy/symbol; no pyramiding",
      `positions abandoned after ${maxHold} bars (timeout)`,
      "funding is NOT modelled (TTT historical funding not integrated)",
    ],
  };
}
