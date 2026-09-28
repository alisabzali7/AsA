/**
 * Psychology context gate.
 *
 * It consumes only explicit user state and recorded evidence. Missing journal,
 * PnL, checklist, or threshold values stay UNKNOWN; they are never converted to
 * a zero, a completed check, or a default cooldown. Descriptive source concepts
 * are not executable unless a source-backed policy is explicitly formalized.
 */
import { sourceCompletenessFor } from "../brain/corpus-manifest";
import type { PsychologyPolicy } from "../brain/types";

export type JournalCoverage = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface PsychologyState {
  /** the user's own declaration, never inferred by AsA */
  declared_state: "ok" | "tilted" | "stressed" | "unfit" | null;
  journal_coverage: JournalCoverage;
  consecutive_losses: number | null;
  minutes_since_last_loss: number | null;
  /** measured account-currency loss as a percentage; null when unavailable */
  daily_loss_pct: number | null;
  /** only known when the journal has been explicitly declared complete */
  trades_today: number | null;
  max_trades_per_day: number | null;
  cooldown_min: number | null;
  checklist_completed: boolean | null;
  security_checklist_completed: boolean | null;
  standards_declared: boolean | null;
  unreviewed_closed_trades: number | null;
  /** distance of current price from the setup's entry zone, in ATR units */
  distance_from_entry_zone_atr: number | null;
  /** policy-provided daily loss ceiling; null when unselected/unspecified */
  daily_loss_limit_pct: number | null;
}

export interface PsychologyGateResult {
  verdict: "pass" | "block" | "flag" | "unknown";
  score_penalty: number;
  blocks: { policy_id: string; name: string; reason: string }[];
  penalties: { policy_id: string; name: string; reason: string; penalty: number }[];
  flags: { policy_id: string; name: string; reason: string }[];
  checklists_required: string[];
  /** policies skipped because their inputs were unknown — stated, not assumed */
  not_evaluated: { policy_id: string; reason: string }[];
  evaluated: number;
  active_policy_ids: string[];
}

/** Missing state is explicit. These nulls intentionally replace old pass-shaped defaults. */
export function defaultPsychologyState(): PsychologyState {
  return {
    declared_state: null,
    journal_coverage: "UNKNOWN",
    consecutive_losses: null,
    minutes_since_last_loss: null,
    daily_loss_pct: null,
    trades_today: null,
    max_trades_per_day: null,
    cooldown_min: null,
    checklist_completed: null,
    security_checklist_completed: null,
    standards_declared: null,
    unreviewed_closed_trades: null,
    distance_from_entry_zone_atr: null,
    daily_loss_limit_pct: null,
  };
}

const activeSourcePolicy = (p: PsychologyPolicy) =>
  p.runtime_status === "LIVE_ADVISORY_ONLY" && p.source_status === "SOURCE_VERIFIED" && p.source_refs.length > 0 &&
  p.source_refs.every((sourceRef) => sourceCompletenessFor(sourceRef.file) === "COMPLETE");

/** Evaluate only source-verified policies whose required state is available. */
export function evaluatePsychologyGate(
  policies: PsychologyPolicy[],
  state: PsychologyState,
): PsychologyGateResult {
  const active = policies.filter(activeSourcePolicy);
  const res: PsychologyGateResult = {
    verdict: "unknown",
    score_penalty: 0,
    blocks: [],
    penalties: [],
    flags: [],
    checklists_required: [],
    not_evaluated: [],
    evaluated: 0,
    active_policy_ids: active.map((p) => p.policy_id),
  };

  for (const policy of policies) {
    if (policy.source_status !== "SOURCE_VERIFIED" || policy.source_refs.length === 0) continue;
    const incomplete = policy.source_refs
      .map((sourceRef) => ({ file: sourceRef.file, completeness: sourceCompletenessFor(sourceRef.file) }))
      .filter((source) => source.completeness !== "COMPLETE");
    if (incomplete.length === 0) continue;
    const sourceStates = [...new Set(incomplete.map((source) => `${source.file}=${source.completeness}`))].join(", ");
    res.not_evaluated.push({
      policy_id: policy.policy_id,
      reason: `cited source completeness is ${sourceStates}; policy remains DISABLED until every cited artifact is COMPLETE and the applicable validation is bound`,
    });
  }

  if (active.length === 0) {
    res.not_evaluated.push({ policy_id: "PSYCHOLOGY-POLICY-SET", reason: "no source-verified, complete, provenance-backed psychology policy is active" });
  }

  for (const p of active) {
    res.evaluated++;
    const unknown = (reason: string) => res.not_evaluated.push({ policy_id: p.policy_id, reason });
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
        if (state.declared_state === null) { unknown("user has not declared an emotional state"); break; }
        add(["tilted", "stressed", "unfit"].includes(state.declared_state),
          `user declared state '${state.declared_state}' — AsA does not diagnose`);
        break;
      }
      case "PSY-REVENGE": {
        if (state.journal_coverage !== "COMPLETE") { unknown(`journal coverage is ${state.journal_coverage}; loss streak is not complete evidence`); break; }
        if (state.consecutive_losses === null || state.minutes_since_last_loss === null || state.cooldown_min === null) {
          unknown("complete journal, consecutive-loss count, last-loss time, or cooldown threshold unavailable"); break;
        }
        add(state.consecutive_losses >= 2 && state.minutes_since_last_loss < state.cooldown_min,
          `${state.consecutive_losses} recorded consecutive losses and ${state.minutes_since_last_loss} minutes since last loss`);
        break;
      }
      case "PSY-COOLDOWN": {
        if (state.journal_coverage !== "COMPLETE" || state.minutes_since_last_loss === null || state.cooldown_min === null) {
          unknown("complete journal, last-loss time, or cooldown threshold unavailable"); break;
        }
        add(state.minutes_since_last_loss < state.cooldown_min,
          `${state.minutes_since_last_loss} minutes since recorded loss; configured cooldown ${state.cooldown_min} minutes`);
        break;
      }
      case "PSY-DAILY-LOSS": {
        if (state.daily_loss_limit_pct === null) { unknown("no selected source-backed risk policy supplies a daily loss limit"); break; }
        if (state.daily_loss_pct === null) { unknown("daily account-currency loss measurement is unavailable; guard is not satisfied"); break; }
        add(state.daily_loss_pct >= state.daily_loss_limit_pct,
          `measured daily loss ${state.daily_loss_pct.toFixed(2)}% reached the selected ${state.daily_loss_limit_pct}% limit`);
        break;
      }
      case "PSY-CHASE": {
        if (state.distance_from_entry_zone_atr === null) { unknown("entry zone or ATR distance is unavailable"); break; }
        add(state.distance_from_entry_zone_atr > 1.5, `price is ${state.distance_from_entry_zone_atr.toFixed(2)} ATR beyond the entry zone`);
        break;
      }
      case "PSY-OVERTRADE": {
        if (state.journal_coverage !== "COMPLETE" || state.trades_today === null || state.max_trades_per_day === null) {
          unknown("complete journal or explicitly selected daily trade-count limit unavailable"); break;
        }
        add(state.trades_today > state.max_trades_per_day,
          `${state.trades_today} recorded trades exceed the explicitly configured ${state.max_trades_per_day} maximum`);
        break;
      }
      case "PSY-CHECKLIST": {
        if (state.checklist_completed === null) { unknown("pre-trade checklist state was not recorded"); break; }
        add(!state.checklist_completed, "pre-trade checklist not completed");
        break;
      }
      case "PSY-REVIEW": {
        if (state.unreviewed_closed_trades === null) { unknown("review-completeness state is unavailable"); break; }
        add(state.unreviewed_closed_trades > 0, `${state.unreviewed_closed_trades} recorded closed trade(s) not reviewed`);
        break;
      }
      case "PSY-STANDARDS": {
        if (state.standards_declared === null) { unknown("personal standards declaration was not recorded"); break; }
        add(!state.standards_declared, "no personal trading standards declared");
        break;
      }
      case "PSY-SECURITY": {
        if (state.security_checklist_completed === null) { unknown("security checklist state was not recorded"); break; }
        add(!state.security_checklist_completed, "account security checklist not completed");
        break;
      }
      default:
        unknown("no deterministic evaluator implemented for this policy");
    }
  }

  res.verdict = res.blocks.length > 0
    ? "block"
    : res.not_evaluated.length > 0
      ? "unknown"
      : res.flags.length > 0 || res.penalties.length > 0
        ? "flag"
        : "pass";
  return res;
}
