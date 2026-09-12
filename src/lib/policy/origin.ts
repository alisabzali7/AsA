/**
 * Policy origin registry (remediation P1-§9).
 *
 * Engineering heuristics MUST NOT look like instructor-authored rules. Every
 * tunable constant used by scoring, level derivation, risk bounds or promotion
 * is registered here with an explicit origin and an independent version, so the
 * UI, the API and the audit can always answer:
 *
 *     "did the corpus say this, or did we choose it?"
 */
export type PolicyOrigin =
  | "SOURCE_VERIFIED"   // the corpus states it, with a citation
  | "SOURCE_INFERRED"   // derived from the corpus, not stated verbatim
  | "ENGINEERING_POLICY"// AsA implementation choice — NOT from the corpus
  | "EMPIRICAL_POLICY"; // chosen from measured results

export interface PolicyParam {
  id: string;
  value: number | string;
  unit: string | null;
  origin: PolicyOrigin;
  description: string;
  /** corpus citation; MUST be empty for ENGINEERING_POLICY */
  source_refs: { file: string; start_line: number; end_line: number }[];
  module: string;
}

/** Versioned independently of source strategy semantics. */
export const ENGINEERING_POLICY_VERSION = "1.0.0";

export const POLICY_PARAMS: PolicyParam[] = [
  {
    id: "STOP_BUFFER_ATR", value: 0.25, unit: "ATR", origin: "ENGINEERING_POLICY",
    description: "Buffer beyond a level when deriving a stop. Quantifies the corpus's qualitative «کمی پایین‌تر» — the corpus states no number.",
    source_refs: [], module: "strategy/compiled/index.ts",
  },
  {
    id: "MAX_TARGET_ATR", value: 20, unit: "ATR", origin: "ENGINEERING_POLICY",
    description: "Sanity bound on target distance. Added after a distant historical level produced an absurd 138R. The corpus states no maximum.",
    source_refs: [], module: "strategy/compiled/index.ts",
  },
  {
    id: "RR_FULL_MARKS", value: 3, unit: "R", origin: "ENGINEERING_POLICY",
    description: "R:R value at which the reward/risk score component reaches 1.0. A scoring curve choice, not a corpus rule.",
    source_refs: [], module: "pipeline/scoring.ts",
  },
  {
    id: "SCORE_THRESHOLD", value: 85, unit: "score", origin: "ENGINEERING_POLICY",
    description: "Opportunity admission threshold. A decision-score cutoff, never a probability.",
    source_refs: [], module: "pipeline/orchestrator.ts",
  },
  {
    id: "UNKNOWN_RULE_PENALTY", value: 3, unit: "score", origin: "ENGINEERING_POLICY",
    description: "Score penalty per UNKNOWN rule in a setup.",
    source_refs: [], module: "pipeline/scoring.ts",
  },
  {
    id: "CONTRADICTION_PENALTY", value: 10, unit: "score", origin: "ENGINEERING_POLICY",
    description: "Score penalty per unresolved contradiction.",
    source_refs: [], module: "pipeline/scoring.ts",
  },
  {
    id: "MIN_RR_GATE", value: 1.5, unit: "R", origin: "ENGINEERING_POLICY",
    description: "Minimum acceptable R:R in the risk engine.",
    source_refs: [], module: "risk/engine.ts",
  },
  {
    id: "MAX_STOP_DISTANCE_PCT", value: 30, unit: "%", origin: "ENGINEERING_POLICY",
    description: "Sanity bound on stop distance.",
    source_refs: [], module: "risk/engine.ts",
  },
  {
    id: "TTT_MAX_BARS_PER_REQUEST", value: 5000, unit: "bars", origin: "ENGINEERING_POLICY",
    description: "Venue response cap used as a transport chunk size. NOT a retention limit.",
    source_refs: [], module: "market/history.ts",
  },
  // ---- genuinely source-stated values, with citations
  {
    id: "DEEP_CORRECTION_FRAC", value: 0.5, unit: "fraction of AB", origin: "SOURCE_VERIFIED",
    description: "AB=CD deep-correction boundary — stated verbatim by the instructor.",
    source_refs: [{ file: "4.txt", start_line: 2425, end_line: 2440 }],
    module: "features/detectors.ts",
  },
  {
    id: "PINBAR_WICK_BODY_RATIO", value: 2, unit: "x body", origin: "SOURCE_VERIFIED",
    description: "Pin-bar wick must be at least 2x the body — stated by the source.",
    source_refs: [{ file: "4.txt", start_line: 2200, end_line: 2210 }],
    module: "features/detectors.ts",
  },
  {
    id: "PRZ_MIN_TOUCHES", value: 5, unit: "touches", origin: "SOURCE_VERIFIED",
    description: "A PRZ needs 5-7 prior reactions — stated by the source.",
    source_refs: [{ file: "2.txt", start_line: 585, end_line: 585 }],
    module: "features/detectors.ts",
  },
  {
    id: "DAILY_LOSS_LIMIT_PCT", value: 5, unit: "%", origin: "SOURCE_VERIFIED",
    description: "Daily loss cap — stated in three separate RAW_4 locations.",
    source_refs: [{ file: "4.txt", start_line: 351, end_line: 351 }],
    module: "brain/policies.ts",
  },
];

export function policyParam(id: string): PolicyParam | undefined {
  return POLICY_PARAMS.find((p) => p.id === id);
}

export function policiesByOrigin(): Record<PolicyOrigin, PolicyParam[]> {
  const out = {
    SOURCE_VERIFIED: [], SOURCE_INFERRED: [], ENGINEERING_POLICY: [], EMPIRICAL_POLICY: [],
  } as Record<PolicyOrigin, PolicyParam[]>;
  for (const p of POLICY_PARAMS) out[p.origin].push(p);
  return out;
}

/**
 * Invariant: an ENGINEERING_POLICY parameter may never carry a corpus citation,
 * and a SOURCE_VERIFIED parameter must always carry one.
 */
export function validatePolicyOrigins(): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const p of POLICY_PARAMS) {
    if (p.origin === "ENGINEERING_POLICY" && p.source_refs.length > 0) {
      violations.push(`${p.id} is ENGINEERING_POLICY but cites the corpus`);
    }
    if (p.origin === "SOURCE_VERIFIED" && p.source_refs.length === 0) {
      violations.push(`${p.id} claims SOURCE_VERIFIED without a citation`);
    }
  }
  return { ok: violations.length === 0, violations };
}
