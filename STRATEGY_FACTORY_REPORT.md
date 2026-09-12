# AsA — Strategy Factory Report

Composes mined components into candidates. It does **not** invent strategies.

## Rules

1. A generated composite is **never** `SOURCE_VERIFIED`. It carries
   `ENGINE_GENERATED` and origin `ENGINE_GENERATED_CANDIDATE`.
2. Combinations require a **LOCATION** (where) and a **TRIGGER** (when), from
   components the corpus teaches **more than once**.
3. Nothing is auto-promoted: every candidate starts `UNTESTED`, and is
   `DISABLED` unless every critical field is present and computable.

## Compatibility gate (§B5)

Direction coherence · timeframe intersection · implemented-detector
availability · semantic coherence (a concept cannot be both trigger and
prohibition).

## Result

- Components available: **621**
- Candidates generated: **55**
- Runtime status: **all DISABLED**
- Rejections recorded with reasons — "why was this NOT generated?" is answerable

Rejections are dominated by `no implemented detector for …`: the corpus teaches
Wyckoff, Elliott and similar concepts AsA has no detector for, so those
combinations are refused rather than faked.

## Lineage on every candidate (§B6)

`strategy_id, origin, component_ids[], components{role→id}, source_refs[],
source_status, semantic_status, empirical_status, runtime_status,
required_features[], required_concepts[], timeframes[], direction, entry_model,
stop_model, target_model, invalidation_model, risk_dependencies[],
psychology_dependencies[], missing_fields[], rationale, disabled_reason,
generation_method, generation_version`

## Honest assessment

**No generated candidate is executable today.** They are compositions of
teaching prose whose components are not yet deterministic predicates. That is
the correct outcome: fabricating thresholds to force executability is exactly
what the governance forbids. The 6 hand-compiled source strategies remain the
only executable set.
