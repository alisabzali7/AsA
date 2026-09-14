/**
 * AsA Brain — knowledge-to-execution type layer.
 *
 * Layers: RAW_SOURCE -> CANONICAL_KNOWLEDGE -> PRIMITIVES/FEATURES ->
 * RULES/SETUPS/STRATEGIES -> SCORE/PSYCHOLOGY/RISK -> OPPORTUNITY.
 *
 * GOVERNANCE ENCODED IN TYPES (not just docs):
 *  - SourceStatus (what the corpus says) and EmpiricalStatus (what tests prove)
 *    are separate types and can never be assigned to one another.
 *  - RuntimeStatus is gated: see `canGoLive()` in gate.ts — a strategy cannot be
 *    LIVE_ADVISORY_ONLY while it holds unresolved critical UNKNOWNs.
 *  - Every knowledge object carries SourceRef[] provenance back to file+line.
 */

/** What the CORPUS says. Never implies anything about performance. */
export type SourceStatus =
  | "SOURCE_VERIFIED"
  | "SOURCE_INFERRED"
  | "UNKNOWN"
  | "CONFLICT"
  | "CLAIM";

/** What MARKET TESTING proves. Never derived from SourceStatus. */
export type EmpiricalStatus =
  | "UNTESTED"
  | "BACKTESTED"
  | "OOS_TESTED"
  | "WALK_FORWARD"
  | "ROBUST"
  | "REJECTED";

/** What the RUNTIME is allowed to do with it. */
export type RuntimeStatus =
  | "DISABLED"
  | "CANDIDATE"
  | "PAPER"
  | "LIVE_ADVISORY_ONLY";

/** Epistemic label the UI/AI must display for every asserted fact. */
export type EvidenceKind =
  | "MEASURED"
  | "SOURCE"
  | "INFERRED"
  | "CLAIM"
  | "UNKNOWN"
  | "UNAVAILABLE"
  | "CONFLICT";

export interface SourceRef {
  /** logical corpus file id, e.g. "1.txt" */
  file: string;
  start_line: number;
  end_line: number;
  /** verbatim snippet — never paraphrased */
  quote?: string;
}

export interface SourceDocument {
  file_id: string;
  filename: string;
  source_hash: string;
  source_version: string;
  immutable: true;
  total_lines: number;
  total_chars: number;
  ingestion_timestamp: number;
  /** true when the supplied bytes were cut mid-content upstream */
  truncated: boolean;
  truncation_note: string | null;
}

export type FragmentClass =
  | "RULE_CANDIDATE"
  | "STRATEGY_DECL"
  | "PSYCHOLOGY"
  | "RISK"
  | "UNKNOWN_MARKER"
  | "CONFLICT_MARKER"
  | "CLAIM"
  | "META_COMMENTARY"
  | "SECTION_HEADER"
  | "NARRATIVE";

export interface SourceFragment {
  fragment_id: string;
  file_id: string;
  start_line: number;
  end_line: number;
  raw_text: string;
  topic_tags: string[];
  fragment_class: FragmentClass;
  /** quarantined fragments are stored but may never become executable rules */
  quarantined: boolean;
  quarantine_reason: string | null;
}

export type KnowledgeType =
  | "principle"
  | "rule"
  | "strategy"
  | "psychology"
  | "risk"
  | "security"
  | "process"
  | "fundamental"
  | "claim";

export interface KnowledgeItem {
  knowledge_id: string;
  type: KnowledgeType;
  canonical_name: string;
  description: string;
  source_refs: SourceRef[];
  source_status: SourceStatus;
  empirical_status: EmpiricalStatus;
  runtime_status: RuntimeStatus;
  confidence: number; // 0..1, epistemic only — NOT a win probability
  conflict_group_id: string | null;
  claim_group_id: string | null;
  unknown_fields: string[];
  external_notes: string[]; // must be prefixed EXTERNAL/INFERRED/ASSUMPTION
  aliases: string[];
}

/* ----------------------------------------------------- primitives/features */

export type PrimitiveKind =
  | "structure"
  | "level"
  | "candle"
  | "indicator"
  | "volatility"
  | "momentum"
  | "regime"
  | "smc"
  | "harmonic"
  | "fibonacci"
  | "divergence"
  | "liquidity";

/** Availability of the underlying data, measured against TTT only. */
export type Availability = "MEASURED" | "DERIVED" | "PROXY" | "UNAVAILABLE";

export interface Primitive {
  primitive_id: string;
  kind: PrimitiveKind;
  canonical_name: string;
  description: string;
  aliases: string[];
  source_refs: SourceRef[];
  source_status: SourceStatus;
  /** implemented detector symbol in the codebase, or null when not yet built */
  detector: string | null;
  availability: Availability;
  unavailable_reason: string | null;
}

export interface FeatureSpec {
  feature_id: string;
  primitive_id: string;
  canonical_name: string;
  /** human/machine readable formula or detector description */
  formula: string;
  inputs: string[];
  timeframes: string[];
  lookback: number | null;
  data_quality: { min_bars: number; max_staleness_ms: number | null };
  edge_cases: string[];
  availability: Availability;
  unavailable_reason: string | null;
  source_refs: SourceRef[];
}

/* ------------------------------------------------------------ rules/setups */

/**
 * How a stored rule is governed (remediation P1).
 * Only MACHINE_EXECUTABLE_RULE may ever drive runtime evaluation.
 */
export type RuleClass =
  | "MACHINE_EXECUTABLE_RULE"
  | "SOURCE_TEXT_RULE"
  | "UNFORMALIZED_RULE"
  | "ENGINEERING_RULE"
  | "UNKNOWN"
  | "CONFLICT"
  | "CLAIM";

/**
 * Explicit binding of a MACHINE_EXECUTABLE_RULE row into the runtime
 * (rule-graph closure). Source-text rules carry `binding: null` — they are
 * never bound to the runtime, and a row that claims a binding without
 * machine predicates is a registry defect, asserted by the closure verifier.
 */
export interface RuleBinding {
  /** Brain strategy id the rule belongs to (identical to the runtime strategy_id) */
  strategy_id: string;
  /** compiled setup id that evaluates this rule */
  setup_id: string;
  /** pipeline stage this rule occupies (context/location/.../filter) */
  stage: string;
  /** the single runtime entry point that consumes the compiled representation */
  consumer: "evaluateRuntime";
}

export interface RuleSpec {
  rule_id: string;
  /** governance class; defaults to UNFORMALIZED_RULE for stored source text */
  rule_class?: RuleClass;
  /** why this rule cannot execute, when applicable */
  non_executable_reason?: string | null;
  /** runtime binding for machine rules; null for source-text rules */
  binding?: RuleBinding | null;
  description: string;
  /** machine-readable predicate expressions evaluated by the rule engine */
  predicates: string[];
  required_features: string[];
  direction: "long" | "short" | "both" | "none";
  timeframe: string | null;
  confirmation: string[];
  invalidation: string[];
  source_refs: SourceRef[];
  missing_fields: string[];
  source_status: SourceStatus;
  empirical_status: EmpiricalStatus;
  runtime_status: RuntimeStatus;
}

export type StrategyFamily =
  | "trend-following"
  | "reversal"
  | "breakout"
  | "pullback"
  | "level-reaction"
  | "momentum-continuation"
  | "divergence"
  | "harmonic"
  | "market-structure"
  | "smc-ob"
  | "multi-indicator"
  | "discretionary-framework"
  | "process-layer";

export interface SetupSpec {
  setup_id: string;
  family: StrategyFamily;
  prerequisites: string[];
  trigger: string[];
  confirmation: string[];
  invalidation: string[];
  entry_model: string | null;
  stop_model: string | null;
  target_model: string | null;
  scoring_weights: Record<string, number>;
  source_refs: SourceRef[];
}

/** The five fields that MUST be known before anything can leave DISABLED. */
export const CRITICAL_SPEC_FIELDS = [
  "entry",
  "stop",
  "target",
  "timeframe",
  "invalidation",
] as const;
export type CriticalSpecField = (typeof CRITICAL_SPEC_FIELDS)[number];

export interface StrategyRecord {
  strategy_id: string;
  canonical_name: string;
  family: StrategyFamily;
  aliases: string[];
  type: string;
  description: string;
  source_refs: SourceRef[];
  source_status: SourceStatus;
  empirical_status: EmpiricalStatus;
  runtime_status: RuntimeStatus;
  /** critical fields the corpus never specified — blocks live eligibility */
  unknown_critical: CriticalSpecField[];
  conflict_group_id: string | null;
  setup_ids: string[];
  rule_ids: string[];
  /** implementation binding into the executable strategy registry, if any */
  implementation: string | null;
  version: string;
  disabled_reason: string | null;
}

/* --------------------------------------------------------------- policies */

export interface RiskPolicy {
  policy_id: string;
  canonical_name: string;
  /** null when the corpus never states it — never invent a number */
  risk_per_trade_pct: number | null;
  daily_loss_limit_pct: number | null;
  max_account_risk_pct: number | null;
  period_loss_limit_pct: number | null;
  max_leverage: number | null;
  max_concurrent_positions: number | null;
  source_refs: SourceRef[];
  source_status: SourceStatus;
  conflict_group_id: string | null;
  runtime_status: RuntimeStatus;
  notes: string;
}

export type PsychologyEffect = "BLOCK" | "REDUCE_SCORE" | "REQUIRE_CHECKLIST" | "FLAG";

export interface PsychologyPolicy {
  policy_id: string;
  canonical_name: string;
  description: string;
  effect: PsychologyEffect;
  /** score penalty applied when effect is REDUCE_SCORE */
  score_penalty: number;
  trigger_condition: string;
  source_refs: SourceRef[];
  source_status: SourceStatus;
  runtime_status: RuntimeStatus;
  user_overridable: boolean;
}

export interface ConflictGroup {
  conflict_group_id: string;
  topic: string;
  /** every competing variant preserved verbatim — never merged or averaged */
  variants: { label: string; statement: string; source_refs: SourceRef[] }[];
  resolution: "UNRESOLVED" | "OPERATOR_CHOSEN" | "EMPIRICALLY_RESOLVED";
  chosen_variant: string | null;
  resolved_by: string | null;
  resolved_at_ms: number | null;
}

export interface ClaimRecord {
  claim_id: string;
  statement: string;
  /** e.g. "90% reversal", "60/40" — stored, never presented as measured */
  quantitative_hint: string | null;
  source_refs: SourceRef[];
  empirical_status: EmpiricalStatus;
  test_result: string | null;
}

export interface BrainStats {
  documents: number;
  fragments: number;
  knowledge_items: number;
  primitives: number;
  features: number;
  rules: number;
  setups: number;
  strategies: number;
  risk_policies: number;
  psychology_policies: number;
  conflicts: number;
  claims: number;
  unknowns: number;
  quarantined: number;
}
