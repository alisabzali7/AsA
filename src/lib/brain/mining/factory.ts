/**
 * Strategy Factory (§B3–B7, §C).
 *
 * Composes mined knowledge atoms into StrategyCandidate records.
 *
 * THREE HARD RULES:
 *  1. A generated composite is NEVER SOURCE_VERIFIED. It carries
 *     SOURCE_DERIVED or ENGINE_GENERATED, always.
 *  2. Combinations are only produced from COMPATIBLE components — no
 *     combinatorial explosion of nonsense. Every rejection is recorded with a
 *     reason so "why was this NOT generated?" is answerable too.
 *  3. Nothing is auto-promoted. Every candidate starts UNTESTED, and its
 *     runtime status is DISABLED unless every critical field is present.
 */
import type { SourceRef } from "../types";
import type { KnowledgeAtom } from "./atoms";

/** How a strategy record came to exist (§B3). */
export type StrategyOrigin =
  | "SOURCE_STRATEGY"           // the instructor named and specified it
  | "SOURCE_DERIVED_COMPOSITE"  // assembled from components the source taught together
  | "ENGINE_GENERATED_CANDIDATE"// assembled by the factory from compatible parts
  | "PROCESS"
  | "PSYCHOLOGY"
  | "SECURITY"
  | "RISK_POLICY"
  | "EDUCATIONAL_EXAMPLE";

export type ComponentRole =
  | "context" | "location" | "structure" | "trigger"
  | "confirmation" | "invalidation" | "entry" | "stop" | "target" | "filter";

export interface StrategyComponent {
  component_id: string;
  role: ComponentRole;
  label: string;
  /** verbatim source sentence */
  source_text: string;
  concepts: string[];
  timeframes: string[];
  direction: "long" | "short" | "both" | "none";
  computable: boolean;
  non_computable_reason: string | null;
  source_refs: SourceRef[];
  atom_ids: string[];
  occurrences: number;
}

export interface StrategyCandidate {
  strategy_id: string;
  name: string;
  origin: StrategyOrigin;
  component_ids: string[];
  components: Record<string, string>;
  source_refs: SourceRef[];
  source_status: "SOURCE_DERIVED" | "ENGINE_GENERATED";
  semantic_status: "EXPLICIT_COMPUTABLE" | "EXPLICIT_NON_COMPUTABLE" | "UNKNOWN";
  empirical_status: "UNTESTED";
  runtime_status: "DISABLED" | "CANDIDATE";
  required_features: string[];
  required_concepts: string[];
  timeframes: string[];
  direction: "long" | "short";
  entry_model: string | null;
  stop_model: string | null;
  target_model: string | null;
  invalidation_model: string | null;
  risk_dependencies: string[];
  psychology_dependencies: string[];
  missing_fields: string[];
  /** human answer to "why does this strategy exist?" */
  rationale: string;
  disabled_reason: string | null;
  generation_method: string;
  generation_version: string;
}

export const GENERATION_VERSION = "1.0.0";

/** Concepts a compiled detector can actually evaluate today. */
export const IMPLEMENTED_CONCEPTS = new Set([
  "support-resistance", "prz", "round-number", "candlestick", "pinbar",
  "market-structure", "bos", "choch", "trend", "range", "breakout",
  "fibonacci", "harmonic", "rsi", "volume",
]);

const ROLE_OF_KIND: Partial<Record<KnowledgeAtom["kind"], ComponentRole>> = {
  CONTEXT: "context",
  LOCATION: "location",
  TRIGGER: "trigger",
  CONFIRMATION: "confirmation",
  INVALIDATION: "invalidation",
  ENTRY: "entry",
  STOP_MODEL: "stop",
  TARGET_MODEL: "target",
  FILTER: "filter",
  PROHIBITION: "filter",
};

/**
 * Group atoms into reusable components.
 * Atoms teaching the same thing (same role + same concept set) collapse into
 * one component with an occurrence count — repetition in the corpus is signal.
 */
export function buildComponents(atoms: KnowledgeAtom[]): StrategyComponent[] {
  const byKey = new Map<string, StrategyComponent>();

  for (const a of atoms) {
    const role = ROLE_OF_KIND[a.kind];
    if (!role) continue;
    if (a.concepts.length === 0) continue;            // nothing a detector could bind
    if (a.semantic_status === "CLAIM") continue;      // claims never become components
    if (a.semantic_status === "CONFLICT") continue;   // unresolved conflicts never execute
    if (a.kind === "EXAMPLE") continue;

    const key = `${role}|${a.concepts.slice().sort().join(",")}|${a.direction}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences++;
      if (existing.source_refs.length < 8) existing.source_refs.push(...a.source_refs);
      existing.atom_ids.push(a.atom_id);
      for (const tf of a.timeframes) if (!existing.timeframes.includes(tf)) existing.timeframes.push(tf);
      // a computable instance upgrades the component
      if (a.semantic_status === "EXPLICIT_COMPUTABLE" && !existing.computable) {
        existing.computable = true;
        existing.non_computable_reason = null;
        existing.source_text = a.text;
      }
      continue;
    }
    byKey.set(key, {
      component_id: `CMP-${role.toUpperCase()}-${a.concepts.slice().sort().join("_")}-${a.direction}`.slice(0, 90),
      role,
      label: `${role}: ${a.concepts.join(" + ")}${a.direction !== "none" ? ` (${a.direction})` : ""}`,
      source_text: a.text,
      concepts: a.concepts.slice(),
      timeframes: a.timeframes.slice(),
      direction: a.direction,
      computable: a.semantic_status === "EXPLICIT_COMPUTABLE",
      non_computable_reason: a.non_computable_reason,
      source_refs: a.source_refs.slice(),
      atom_ids: [a.atom_id],
      occurrences: 1,
    });
  }
  return [...byKey.values()].sort((x, y) => y.occurrences - x.occurrences);
}

export interface CompatibilityVerdict {
  compatible: boolean;
  reasons: string[];
}

/**
 * Compatibility gate (§B5). Every check must pass before a combination exists.
 */
export function checkCompatibility(parts: StrategyComponent[], direction: "long" | "short"): CompatibilityVerdict {
  const reasons: string[] = [];

  // direction coherence — a component teaching the opposite side is disqualifying
  for (const p of parts) {
    if (p.direction !== "none" && p.direction !== "both" && p.direction !== direction) {
      reasons.push(`${p.component_id} is ${p.direction}-only but the candidate is ${direction}`);
    }
  }

  // timeframe coherence — components that each name TFs must share at least one
  const constrained = parts.filter((p) => p.timeframes.length > 0);
  if (constrained.length > 1) {
    const shared = constrained.reduce<string[]>(
      (acc, p) => acc.filter((tf) => p.timeframes.includes(tf)),
      constrained[0].timeframes.slice(),
    );
    if (shared.length === 0) reasons.push("components declare disjoint timeframes");
  }

  // feature availability — every concept needs an implemented detector
  const missing = [...new Set(parts.flatMap((p) => p.concepts))].filter((c) => !IMPLEMENTED_CONCEPTS.has(c));
  if (missing.length > 0) reasons.push(`no implemented detector for: ${missing.join(", ")}`);

  // semantic conflict — the same concept used as both trigger and prohibition
  const trig = new Set(parts.filter((p) => p.role === "trigger").flatMap((p) => p.concepts));
  const filt = parts.filter((p) => p.role === "filter");
  for (const f of filt) {
    for (const c of f.concepts) {
      if (trig.has(c) && /نباید|ممنوع/.test(f.source_text)) {
        reasons.push(`concept '${c}' is both a trigger and a prohibition — semantically incoherent`);
      }
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

export interface FactoryResult {
  candidates: StrategyCandidate[];
  rejected: { combination: string; reasons: string[] }[];
  components_used: number;
  combinations_considered: number;
}

/**
 * Generate candidates from compatible components.
 *
 * Deliberately conservative: a candidate requires a LOCATION (where) and a
 * TRIGGER (when) at minimum. Without both there is no strategy — only a
 * fragment — so nothing is fabricated to fill the gap.
 */
export function generateCandidates(
  components: StrategyComponent[],
  opts: { maxCandidates?: number; minOccurrences?: number } = {},
): FactoryResult {
  const maxOut = opts.maxCandidates ?? 200;
  const minOcc = opts.minOccurrences ?? 2; // taught more than once
  const rejected: { combination: string; reasons: string[] }[] = [];
  const candidates: StrategyCandidate[] = [];
  let considered = 0;

  const pick = (role: ComponentRole) =>
    components.filter((c) => c.role === role && c.occurrences >= minOcc).slice(0, 6);

  const locations = pick("location");
  const triggers = pick("trigger");
  const contexts = pick("context");
  const confirmations = pick("confirmation");
  const stops = pick("stop");
  const targets = pick("target");
  const invalidations = pick("invalidation");

  for (const direction of ["long", "short"] as const) {
    for (const loc of locations) {
      for (const trg of triggers) {
        if (candidates.length >= maxOut) break;
        considered++;

        const ctx = contexts.find((c) => c.direction === direction || c.direction === "none" || c.direction === "both");
        const conf = confirmations.find((c) => c.direction === direction || c.direction === "none" || c.direction === "both");
        const stop = stops[0];
        const tgt = targets[0];
        const inval = invalidations[0];

        const parts = [loc, trg, ctx, conf, stop, tgt, inval].filter(Boolean) as StrategyComponent[];
        const verdict = checkCompatibility(parts, direction);
        const combo = `${direction}|${loc.component_id}|${trg.component_id}`;
        if (!verdict.compatible) {
          if (rejected.length < 100) rejected.push({ combination: combo, reasons: verdict.reasons });
          continue;
        }

        const missing: string[] = [];
        if (!stop) missing.push("stop");
        if (!tgt) missing.push("target");
        if (!inval) missing.push("invalidation");
        if (!conf) missing.push("confirmation");

        const tfs = [...new Set(parts.flatMap((p) => p.timeframes))];
        const concepts = [...new Set(parts.flatMap((p) => p.concepts))];
        const allComputable = parts.every((p) => p.computable);

        // Runtime policy: only a candidate with EVERY critical field present and
        // fully computable components may reach CANDIDATE. Everything else is
        // DISABLED with the exact missing pieces named.
        const runtime: StrategyCandidate["runtime_status"] =
          missing.length === 0 && allComputable ? "CANDIDATE" : "DISABLED";

        candidates.push({
          strategy_id: `GEN-${direction.toUpperCase()}-${candidates.length + 1}`,
          name: `${loc.concepts.join("+")} @ ${trg.concepts.join("+")} (${direction})`,
          origin: "ENGINE_GENERATED_CANDIDATE",
          component_ids: parts.map((p) => p.component_id),
          components: Object.fromEntries(parts.map((p) => [p.role, p.component_id])),
          source_refs: parts.flatMap((p) => p.source_refs).slice(0, 12),
          // NEVER SOURCE_VERIFIED — this is machine composition
          source_status: "ENGINE_GENERATED",
          semantic_status: allComputable ? "EXPLICIT_COMPUTABLE" : "EXPLICIT_NON_COMPUTABLE",
          empirical_status: "UNTESTED",
          runtime_status: runtime,
          required_features: concepts.filter((c) => IMPLEMENTED_CONCEPTS.has(c)),
          required_concepts: concepts,
          timeframes: tfs,
          direction,
          entry_model: loc.source_text.slice(0, 240),
          stop_model: stop?.source_text.slice(0, 240) ?? null,
          target_model: tgt?.source_text.slice(0, 240) ?? null,
          invalidation_model: inval?.source_text.slice(0, 240) ?? null,
          risk_dependencies: ["RISK-ASA-CONSERVATIVE-DEFAULT"],
          psychology_dependencies: ["PSY-DAILY-LOSS", "PSY-EMOTIONAL-STATE"],
          missing_fields: missing,
          rationale:
            `Composed from components the corpus teaches repeatedly: ` +
            parts.map((p) => `${p.role}(${p.concepts.join("+")}, x${p.occurrences})`).join(" + ") +
            `. This is a MACHINE COMPOSITION, not an instructor-taught strategy.`,
          disabled_reason: runtime === "DISABLED"
            ? (missing.length ? `missing critical field(s): ${missing.join(", ")}` : "one or more components are not deterministically computable")
            : null,
          generation_method: "component-composition:location×trigger+context+confirmation+stop+target+invalidation",
          generation_version: GENERATION_VERSION,
        });
      }
    }
  }

  return {
    candidates,
    rejected,
    components_used: components.length,
    combinations_considered: considered,
  };
}
