/**
 * Stage 5 — psychology gate.
 *
 * Kept deliberately separate from signal generation (governance I): psychology
 * never CREATES a setup, it only blocks, penalizes, or flags one.
 *
 * The engine evaluates corpus-derived policies against a persistent user state.
 * It records the user's OWN declarations; it never infers a psychological or
 * medical diagnosis (master prompt: "must not invent medical/mental-health
 * diagnoses").
 */
import type { PsychologyPolicy } from "../brain/types";

export interface PsychologyState {
  /** the user's own declaration, never inferred by AsA */
  declared_state: "ok" | "tilted" | "stressed" | "unfit" | null;
  consecutive_losses: number;
  minutes_since_last_loss: number | null;
  daily_loss_pct: number;
  trades_today: number;
  max_trades_per_day: number;
  cooldown_min: number;
  checklist_completed: boolean;
  security_checklist_completed: boolean;
  standards_declared: boolean;
  unreviewed_closed_trades: number;
  /** distance of current price from the setup's entry zone, in ATR units */
  distance_from_entry_zone_atr: number | null;
  /** policy-provided daily loss ceiling; null when the policy omits it */
  daily_loss_limit_pct: number | null;
}

export interface PsychologyGateResult {
  verdict: "pass" | "block" | "flag";
  /** total score penalty to subtract from the opportunity score */
  score_penalty: number;
  blocks: { policy_id: string; name: string; reason: string }[];
  penalties: { policy_id: string; name: string; reason: string; penalty: number }[];
  flags: { policy_id: string; name: string; reason: string }[];
  checklists_required: string[];
  /** policies skipped because their inputs were unknown — stated, not assumed */
  not_evaluated: { policy_id: string; reason: string }[];
  evaluated: number;
}

export function defaultPsychologyState(): PsychologyState {
  return {
    declared_state: null,
    consecutive_losses: 0,
    minutes_since_last_loss: null,
    daily_loss_pct: 0,
    trades_today: 0,
    max_trades_per_day: 5,
    cooldown_min: 60,
    checklist_completed: false,
    security_checklist_completed: false,
    standards_declared: false,
    unreviewed_closed_trades: 0,
    distance_from_entry_zone_atr: null,
    daily_loss_limit_pct: null,
  };
}

/**
 * Evaluate every ACTIVE policy against the state.
 *
 * A policy whose inputs are unknown is NOT silently treated as passing — it is
 * reported in `not_evaluated` with the missing input named, so the UI can show
 * that the guard was inactive rather than satisfied.
 */
export function evaluatePsychologyGate(
  policies: PsychologyPolicy[],
  state: PsychologyState,
): PsychologyGateResult {
  const res: PsychologyGateResult = {
    verdict: "pass",
    score_penalty: 0,
    blocks: [],
    penalties: [],
    flags: [],
    checklists_required: [],
    not_evaluated: [],
    evaluated: 0,
  };

  const active = policies.filter((p) => p.runtime_status !== "DISABLED");

  for (const p of active) {
    res.evaluated++;
    const add = (hit: boolean, reason: string) => {
      if (!hit) return;
      if (p.effect === "BLOCK") res.blocks.push({ policy_id: p.policy_id, name: p.canonical_name, reason });
      else if (p.effect === "REDUCE_SCORE") {
        res.penalties.push({ policy_id: p.policy_id, name: p.canonical_name, reason, penalty: p.score_penalty });
        res.score_penalty += p.score_penalty;
      } else if (p.effect === "REQUIRE_CHECKLIST") {
        res.checklists_required.push(p.canonical_name);
        res.flags.push({ policy_id: p.policy_id, name: p.canonical_name, reason });
      } else res.flags.push({ policy_id: p.policy_id, name: p.canonical_name, reason });
    };

    switch (p.policy_id) {
      case "PSY-EMOTIONAL-STATE": {
        if (state.declared_state === null) {
          res.not_evaluated.push({ policy_id: p.policy_id, reason: "user has not declared an emotional state" });
          break;
        }
        add(
          ["tilted", "stressed", "unfit"].includes(state.declared_state),
          `user declared state '${state.declared_state}' — advisory suppressed by the user's own standard (AsA does not diagnose)`,
        );
        break;
      }
      case "PSY-REVENGE": {
        if (state.minutes_since_last_loss === null) {
          res.not_evaluated.push({ policy_id: p.policy_id, reason: "no recorded loss timestamp" });
          break;
        }
        add(
          state.consecutive_losses >= 2 && state.minutes_since_last_loss < state.cooldown_min,
          `${state.consecutive_losses} consecutive losses and only ${state.minutes_since_last_loss} min since the last one (cooldown ${state.cooldown_min} min)`,
        );
        break;
      }
      case "PSY-COOLDOWN": {
        if (state.minutes_since_last_loss === null) {
          res.not_evaluated.push({ policy_id: p.policy_id, reason: "no recorded loss timestamp" });
          break;
        }
        add(
          state.minutes_since_last_loss < state.cooldown_min,
          `only ${state.minutes_since_last_loss} min since the last loss (cooldown ${state.cooldown_min} min)`,
        );
        break;
      }
      case "PSY-DAILY-LOSS": {
        if (state.daily_loss_limit_pct === null) {
          res.not_evaluated.push({
            policy_id: p.policy_id,
            reason: "selected risk policy does not specify a daily loss limit — guard inactive, not satisfied",
          });
          break;
        }
        add(
          state.daily_loss_pct >= state.daily_loss_limit_pct,
          `daily loss ${state.daily_loss_pct.toFixed(2)}% reached the ${state.daily_loss_limit_pct}% limit`,
        );
        break;
      }
      case "PSY-CHASE": {
        if (state.distance_from_entry_zone_atr === null) {
          res.not_evaluated.push({ policy_id: p.policy_id, reason: "no entry zone / ATR available for this candidate" });
          break;
        }
        add(
          state.distance_from_entry_zone_atr > 1.5,
          `price is ${state.distance_from_entry_zone_atr.toFixed(2)} ATR beyond the entry zone — chasing`,
        );
        break;
      }
      case "PSY-OVERTRADE":
        add(
          state.trades_today > state.max_trades_per_day,
          `${state.trades_today} trades today exceeds the ${state.max_trades_per_day} self-imposed maximum`,
        );
        break;
      case "PSY-CHECKLIST":
        add(!state.checklist_completed, "pre-trade checklist not completed");
        break;
      case "PSY-REVIEW":
        add(state.unreviewed_closed_trades > 0, `${state.unreviewed_closed_trades} closed trade(s) not yet reviewed`);
        break;
      case "PSY-STANDARDS":
        add(!state.standards_declared, "no personal trading standards declared");
        break;
      case "PSY-SECURITY":
        add(!state.security_checklist_completed, "account security checklist not completed");
        break;
      default:
        res.not_evaluated.push({ policy_id: p.policy_id, reason: "no evaluator implemented for this policy" });
    }
  }

  res.verdict = res.blocks.length > 0 ? "block" : res.flags.length > 0 || res.penalties.length > 0 ? "flag" : "pass";
  return res;
}
