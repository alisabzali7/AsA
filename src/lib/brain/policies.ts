/**
 * Risk + psychology policy registries, and conflict groups.
 *
 * THE CENTRAL RULE OF THIS FILE (master prompt, "IMPORTANT RISK RULE"):
 * the corpus states DIFFERENT risk percentages in different sessions. We do
 * NOT pick one and hard-code it as universal truth, and we do NOT average
 * them. Every stated figure becomes its own CANDIDATE policy carrying the
 * exact source lines, grouped under one conflict group. Production selection
 * is an explicit operator decision recorded with attribution.
 *
 * Line references below were verified by grep against the supplied RAW files
 * during Stage 0 and are reproducible with:
 *   grep -n "ریسک" knowledge/raw/RAW_*.txt
 */
import type { ConflictGroup, PsychologyPolicy, RiskPolicy, SourceRef } from "./types";

const ref = (file: string, line: number, quote: string): SourceRef => ({
  file, start_line: line, end_line: line, quote,
});

export const RISK_CONFLICT_GROUP = "CFG-RISK-PCT";

export function buildRiskPolicies(): RiskPolicy[] {
  const base = {
    empirical: "UNTESTED" as const,
    runtime: "CANDIDATE" as const,
  };

  return [
    {
      policy_id: "RISK-2PCT-PER-TRADE",
      canonical_name: "Fixed 2% risk per trade (RAW_1)",
      risk_per_trade_pct: 2,
      daily_loss_limit_pct: null,
      max_account_risk_pct: null,
      period_loss_limit_pct: null,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [
        ref("1.txt", 286, "ریسک دقیقاً روی ۲ درصد"),
        ref("1.txt", 329, "ریسک ۲ درصد"),
        ref("1.txt", 854, "ریسک ۲ درصد"),
        ref("1.txt", 876, "ریسکِ ثابت (مانند ریسک ۲ درصد)"),
      ],
      source_status: "CONFLICT",
      conflict_group_id: RISK_CONFLICT_GROUP,
      runtime_status: base.runtime,
      notes: "Stated repeatedly in RAW_1 as a fixed per-trade risk. Conflicts with the 1% figure in RAW_4/RAW_5.",
    },
    {
      policy_id: "RISK-1PCT-PER-TRADE",
      canonical_name: "1% normal risk per trade (RAW_5 / RAW_4)",
      risk_per_trade_pct: 1,
      daily_loss_limit_pct: null,
      max_account_risk_pct: null,
      period_loss_limit_pct: null,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [
        ref("5.txt", 284, "ریسک نرمال در هر معامله: 1%"),
        ref("4.txt", 2718, "ریسک، 1 درصد"),
        ref("4.txt", 2200, "ریسک‌فری شدن، این 1 درصد"),
      ],
      source_status: "CONFLICT",
      conflict_group_id: RISK_CONFLICT_GROUP,
      runtime_status: base.runtime,
      notes: "Stated as the normal per-trade risk. Conflicts with the 2% figure in RAW_1.",
    },
    {
      policy_id: "RISK-2PCT-POSITION-CAP",
      canonical_name: "Per-position cap 2% (RAW_4)",
      risk_per_trade_pct: 2,
      daily_loss_limit_pct: null,
      max_account_risk_pct: null,
      period_loss_limit_pct: null,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [ref("4.txt", 1912, "ریسک پوزیشن‌ها نباید بیشتر از ۲ درصد")],
      source_status: "CONFLICT",
      conflict_group_id: RISK_CONFLICT_GROUP,
      runtime_status: base.runtime,
      notes: "Expressed as a ceiling ('must not exceed'), not a target — semantically different from the RAW_1 fixed 2%.",
    },
    {
      policy_id: "RISK-DAILY-5PCT",
      canonical_name: "Daily loss limit 5% (RAW_4)",
      risk_per_trade_pct: null,
      daily_loss_limit_pct: 5,
      max_account_risk_pct: null,
      period_loss_limit_pct: null,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [
        ref("4.txt", 351, "ریسک کل روزانه نباید از ۵ درصد"),
        ref("4.txt", 1313, "ریسک مجاز روزانه: حداکثر ۵ درصد"),
        ref("4.txt", 1346, "ریسک الگوریتمی: اگر ضرر روزانه از ۵ درصد"),
      ],
      source_status: "SOURCE_VERIFIED",
      conflict_group_id: null,
      runtime_status: base.runtime,
      notes: "Consistently stated across three RAW_4 locations; not in conflict with the per-trade figures (different dimension).",
    },
    {
      policy_id: "RISK-ACCOUNT-11PCT",
      canonical_name: "Total account risk ~11% (RAW_4)",
      risk_per_trade_pct: null,
      daily_loss_limit_pct: null,
      max_account_risk_pct: 11,
      period_loss_limit_pct: null,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [ref("4.txt", 1898, "ریسک کلی اکانت حدود ۱۱ درصد"), ref("4.txt", 1958, "ریسک ۱۱ درصد")],
      source_status: "SOURCE_VERIFIED",
      conflict_group_id: null,
      runtime_status: base.runtime,
      notes: "Aggregate open-risk figure (portfolio heat ceiling).",
    },
    {
      policy_id: "RISK-PERIOD-15PCT",
      canonical_name: "Period loss limit 15% (RAW_4)",
      risk_per_trade_pct: null,
      daily_loss_limit_pct: null,
      max_account_risk_pct: null,
      period_loss_limit_pct: 15,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [ref("4.txt", 1934, "ریسک کل در طول دوره نباید از ۱۵ درصد"), ref("4.txt", 1958, "ریسک کل دوره نباید بالای ۱۵ درصد")],
      source_status: "SOURCE_VERIFIED",
      conflict_group_id: null,
      runtime_status: base.runtime,
      notes: "Drawdown ceiling over the training/trading period.",
    },
    {
      policy_id: "RISK-TOLERANCE-5PCT",
      canonical_name: "5% tolerance example (RAW_4)",
      risk_per_trade_pct: 5,
      daily_loss_limit_pct: null,
      max_account_risk_pct: null,
      period_loss_limit_pct: null,
      max_leverage: null,
      max_concurrent_positions: null,
      source_refs: [ref("4.txt", 202, "ریسک: اگر تحمل 5%"), ref("4.txt", 2718, "ریسکی که میتونه بکنه 5 درصد")],
      source_status: "CLAIM",
      conflict_group_id: RISK_CONFLICT_GROUP,
      runtime_status: "DISABLED",
      notes: "Presented as a tolerance EXAMPLE, not a prescribed policy. Kept as a source variant; disabled for production per governance (examples are not rules).",
    },
    {
      policy_id: "RISK-ASA-CONSERVATIVE-DEFAULT",
      canonical_name: "AsA conservative default (ENGINEERING ASSUMPTION)",
      risk_per_trade_pct: 1,
      daily_loss_limit_pct: 5,
      max_account_risk_pct: 11,
      period_loss_limit_pct: 15,
      max_leverage: 5,
      max_concurrent_positions: 5,
      source_refs: [],
      source_status: "SOURCE_INFERRED",
      conflict_group_id: null,
      runtime_status: "CANDIDATE",
      notes:
        "ASSUMPTION (engineering, not source): takes the SMALLEST per-trade figure in the corpus (1%) as the safe default and combines it with the non-conflicting daily/account/period ceilings. Explicitly marked SOURCE_INFERRED. The operator must consciously select a production policy; this is not presented as the corpus's answer.",
    },
  ];
}

export function buildPsychologyPolicies(): PsychologyPolicy[] {
  /**
   * PROVENANCE DISCIPLINE (closure §G): a policy is SOURCE_VERIFIED only when
   * the corpus actually states it. Numeric thresholds the corpus never gave
   * (cooldown minutes, chase distance, max trades/day) are ENGINEERING
   * ASSUMPTIONS and are labelled SOURCE_INFERRED with NO source refs, so they
   * can never be presented as something the instructor taught.
   */
  const p = (
    id: string, name: string, desc: string, effect: PsychologyPolicy["effect"],
    penalty: number, trigger: string, refs: SourceRef[],
    sourceStatus: PsychologyPolicy["source_status"], overridable: boolean,
  ): PsychologyPolicy => ({
    policy_id: id, canonical_name: name, description: desc, effect, score_penalty: penalty,
    trigger_condition: trigger, source_refs: refs, source_status: sourceStatus,
    runtime_status: "LIVE_ADVISORY_ONLY", user_overridable: overridable,
  });

  return [
    // --- source-supported: the daily loss cap is stated verbatim in RAW_4
    p("PSY-DAILY-LOSS", "Daily loss stop",
      "When the daily loss limit is reached, no further advisory signals are surfaced for the day.",
      "BLOCK", 0, "daily_loss_pct >= risk_policy.daily_loss_limit_pct",
      [ref("4.txt", 351, "ریسک کل روزانه نباید از ۵ درصد"), ref("4.txt", 1313, "ریسک مجاز روزانه: حداکثر ۵ درصد")],
      "SOURCE_VERIFIED", false),

    // --- source-supported concept, ENGINEERING threshold
    p("PSY-REVENGE", "Revenge-trading block",
      "After consecutive losses, re-entering to 'win it back' is blocked until the cooldown expires. The CONCEPT is source-supported; the 2-loss trigger is an ENGINEERING ASSUMPTION, not a corpus number.",
      "BLOCK", 0, "consecutive_losses >= 2 AND minutes_since_last_loss < cooldown_min  [threshold: ENGINEERING_ASSUMPTION]",
      [ref("4.txt", 1346, "ریسک الگوریتمی: اگر ضرر روزانه از ۵ درصد")],
      "SOURCE_INFERRED", false),

    // --- pure ENGINEERING ASSUMPTIONS: no source refs at all
    p("PSY-COOLDOWN", "Post-loss cooldown",
      "A mandatory pause after a loss. ENGINEERING ASSUMPTION: the corpus never specifies a cooldown duration. Because the number is not source-derived, the operator may override it.",
      "BLOCK", 0, "minutes_since_last_loss < cooldown_min  [duration: ENGINEERING_ASSUMPTION]",
      [], "SOURCE_INFERRED", true),

    p("PSY-CHASE", "Chasing / FOMO guard",
      "Entering after price has run far from the setup level is penalised. ENGINEERING ASSUMPTION: the 1.5-ATR distance is not a corpus figure.",
      "REDUCE_SCORE", 15, "distance_from_entry_zone_atr > 1.5  [threshold: ENGINEERING_ASSUMPTION]",
      [], "SOURCE_INFERRED", true),

    p("PSY-OVERTRADE", "Overtrading guard",
      "Too many trades in a session degrades quality. Boundary is STRICTLY GREATER THAN the configured maximum: taking exactly max_trades_per_day is allowed, the next one is penalised. The limit itself is an ENGINEERING_ASSUMPTION — the corpus states no trade count.",
      "REDUCE_SCORE", 10, "trades_today > max_trades_per_day  [limit: user-configured, ENGINEERING default]",
      [], "SOURCE_INFERRED", true),

    // --- source-supported process requirements
    p("PSY-CHECKLIST", "Pre-trade checklist",
      "A setup must pass the user's explicit pre-trade checklist. SOFT gate: it flags and requires acknowledgement rather than hard-blocking, because the corpus frames it as process discipline, not a market condition.",
      "REQUIRE_CHECKLIST", 0, "checklist_completed == false", [], "SOURCE_VERIFIED", false),

    p("PSY-REVIEW", "Post-trade review requirement",
      "Journaling/review is required; missing reviews flag subsequent signals.",
      "FLAG", 0, "unreviewed_closed_trades > 0", [], "SOURCE_VERIFIED", true),

    p("PSY-STANDARDS", "Standards over vague discipline",
      "The corpus frames discipline as concrete personal STANDARDS rather than willpower.",
      "FLAG", 0, "standards_declared == false", [], "SOURCE_VERIFIED", false),

    p("PSY-EMOTIONAL-STATE", "Emotional-state restriction",
      "A user-declared unstable state blocks advisory output. AsA records the user's OWN declaration only and never infers a psychological or medical diagnosis.",
      "BLOCK", 0, "user_declared_state in ('tilted','stressed','unfit')", [], "SOURCE_VERIFIED", false),

    p("PSY-SECURITY", "Account security hygiene",
      "Security routine (2FA, withdrawal whitelist, key hygiene) is a process-layer requirement, not a trading signal.",
      "FLAG", 0, "security_checklist_completed == false", [], "SOURCE_VERIFIED", false),
  ];
}

/**
 * Build conflict groups. The risk group is authored explicitly (we know the
 * exact competing variants); textual CONFLICT markers found during ingestion
 * are preserved as their own group so nothing is lost.
 */
export function buildConflictGroups(
  conflictLines: { file: string; line: number; text: string }[],
): ConflictGroup[] {
  const groups: ConflictGroup[] = [
    {
      conflict_group_id: RISK_CONFLICT_GROUP,
      topic: "Risk percentage per trade",
      variants: [
        {
          label: "2% fixed per trade",
          statement: "ریسک دقیقاً روی ۲ درصد — a fixed 2% of equity risked per trade.",
          source_refs: [ref("1.txt", 286, "ریسک دقیقاً روی ۲ درصد"), ref("1.txt", 329, "ریسک ۲ درصد")],
        },
        {
          label: "1% normal per trade",
          statement: "ریسک نرمال در هر معامله: 1% — 1% is the normal per-trade risk.",
          source_refs: [ref("5.txt", 284, "ریسک نرمال در هر معامله: 1%"), ref("4.txt", 2718, "ریسک، 1 درصد")],
        },
        {
          label: "2% ceiling per position",
          statement: "ریسک پوزیشن‌ها نباید بیشتر از ۲ درصد — 2% is a maximum, not a target.",
          source_refs: [ref("4.txt", 1912, "ریسک پوزیشن‌ها نباید بیشتر از ۲ درصد")],
        },
        {
          label: "5% tolerance example",
          statement: "ریسک: اگر تحمل 5% — presented as an example of risk tolerance, not a rule.",
          source_refs: [ref("4.txt", 202, "ریسک: اگر تحمل 5%")],
        },
      ],
      resolution: "UNRESOLVED",
      chosen_variant: null,
      resolved_by: null,
      resolved_at_ms: null,
    },
    {
      conflict_group_id: "CFG-STOP-METHOD",
      topic: "Stop-loss methodology",
      variants: [
        {
          label: "Traditional fixed SL",
          statement: "A stop-loss order is placed at a structural level when the position is opened.",
          source_refs: [],
        },
        {
          label: "No initial SL / mental stop",
          statement: "Some sessions describe operating without an initial hard stop, using structural exit instead.",
          source_refs: [],
        },
        {
          label: "Emergency structural exit",
          statement: "Exit is triggered by structure invalidation rather than a fixed price.",
          source_refs: [],
        },
      ],
      resolution: "UNRESOLVED",
      chosen_variant: null,
      resolved_by: null,
      resolved_at_ms: null,
    },
  ];

  // Preserve every textual CONFLICT marker found in the corpus.
  if (conflictLines.length > 0) {
    groups.push({
      conflict_group_id: "CFG-SOURCE-MARKED",
      topic: `Source-marked contradictions (${conflictLines.length} lines)`,
      variants: conflictLines.slice(0, 200).map((c, i) => ({
        label: `${c.file}:${c.line}`,
        statement: c.text.slice(0, 600),
        source_refs: [ref(c.file, c.line, c.text.slice(0, 300))],
      })),
      resolution: "UNRESOLVED",
      chosen_variant: null,
      resolved_by: null,
      resolved_at_ms: null,
    });
  }
  return groups;
}
