# Brain Closure Audit — Rule Registry → Machine Rule Graph → Runtime Strategy

**Repository:** `alisabzali7/AsA`
**Branch:** `arena/01a0a02d-asa`
**Audit base commit:** `1d9d5df` (HEAD of `main` at audit start) — the closure milestone is contained in the single commit that adds this artifact.
**Audit timestamp:** 2026-09-14 (UTC)
**App version:** `asa@6.0.1` (schema migration: additive `rules.binding` column)
**Production truth:** The True Trade (TTT) only; TONUSDT permanently excluded; no fixture/legacy universe used as production truth anywhere in this audit.

---

## 1. Method

Every statement below was derived from source code, SQL state of an ingested
brain DB (`npm run brain:ingest`, coverage 9398/9398 lines), and executed
tests — never from prior reports. Where a prior report disagreed with code,
code won.

## 2. Closure map (post-milestone)

| Stage | Implemented | Source file(s) | Type / Table | Provenance | Runtime consumer | Status |
|---|---|---|---|---|---|---|
| RAW_SOURCE | ✅ | `src/lib/brain/ingest.ts` (`ingestCorpus`) | `source_documents`, `source_fragments` (brain.db) | sha256 per file, one fragment per line, file+line refs | — (immutable substrate) | CLOSED |
| CANONICAL_KNOWLEDGE | ✅ | `src/lib/brain/ingest.ts`, `classify.ts`, `compile.ts` | `knowledge_items`, `strategies`, `setups`, `conflict_groups`, `claims` | `source_refs` on every row | brain UI/API (`/api/brain/*`) | CLOSED |
| PRIMITIVES / FEATURES | ✅ | `src/lib/brain/primitives.ts`, `src/lib/features/detectors.ts` | `primitives`, `features`; `FeatureValue<T>` | availability measured vs TTT; detector_version | feature bags built by compiled strategies | CLOSED |
| RULE REGISTRY | ✅ | `src/lib/brain/store.ts` (`rules`), `ingest.ts` | `rules` table, `RuleSpec`, `RuleClass`, `RuleBinding` | text rows: corpus file+line; machine rows: inherited from compiled rules | `/api/brain/rules`, `verifyRuleRegistryClosure` | CLOSED (this milestone) |
| MACHINE RULE GRAPH | ✅ | `src/lib/strategy/rule-graph.ts` (`buildMachineRuleGraph`) | `MachineRuleGraph` (nodes + edges + semantics), persisted as `MACHINE_EXECUTABLE_RULE` rows + `brain_meta.machine_rule_graph` | node.source_refs / source_text | registration at ingest; closure verifier; `/api/brain/rules` | CLOSED (this milestone) |
| COMPILED PREDICATE | ✅ | `src/lib/rules/engine.ts` (`RuleDefinition`, `RulePredicate`), `src/lib/strategy/compiled/{prz-levels,harmonic-abcd}.ts` | 31 `RuleDefinition`s with structural predicates | verbatim `source_text` + `source_refs` per rule | `evaluateRule` → `evaluateSetup` | CLOSED |
| SETUP INPUTS | ✅ | `src/lib/rules/setup.ts` (`SetupDefinition`, stage pipeline) | CONTEXT→LOCATION→STRUCTURE→TRIGGER→CONFIRMATION→INVALIDATION + FILTER | setup `source_refs` | `evaluateSetup` | CLOSED |
| STRATEGY | ✅ | `src/lib/strategy/compiled/index.ts`, `src/lib/strategy/runtime.ts` | `CompiledStrategy`, `StrategyRuntimeDefinition` | strategy-level lineage verified (`strategy/lineage.ts`) | `PRODUCTION_STRATEGIES()` | CLOSED |
| RUNTIME CONSUMER | ✅ | `src/lib/pipeline/orchestrator.ts` (`scanSymbol`, line 129 `evaluateRuntime`), `src/lib/pipeline/brain-scanner.ts` (`evaluateCompiled`), `src/lib/backtest/strategy-runner.ts` (`evaluateCompiled`) | — | every evaluation carries `source_refs`, `features_used`, `version` | advisory pipeline, opportunity scanner, backtester — ONE evaluation path | CLOSED |

### Broken edges

| FROM → TO | Location | Why broken | Impact | Status |
|---|---|---|---|---|
| RULE REGISTRY → MACHINE RULE GRAPH | was: no code anywhere | `rules` table held only 503 text rows (`predicates=[]`); the 31 executable rules existed only as TS closures with no registry representation; `MACHINE_EXECUTABLE_RULE` class declared in `src/lib/brain/types.ts` but never written | registry could not answer "which of my rules execute?"; no machine rule graph existed | **FIXED** — `rule-graph.ts` + ingest registration |
| MACHINE RULE GRAPH → COMPILED PREDICATE | was: no IR | predicates were implicit in closures; nothing validated their identity against the registry | silent drift between registry and runtime undetectable | **FIXED** — `verifyRuleRegistryClosure` (bidirectional) |
| STRATEGY record → its rules | was: `src/lib/brain/ingest.ts:213,264` `rule_ids: []` | every record listed zero rules, including the 6 with compiled implementations | lineage stopped at strategy level | **FIXED** — records now carry exact runtime rule ids + `compiled:` binding |
| Rule → verbatim source sentence | was: `prz-levels.ts` `doublePatternSetup` | `R-1258-short-TRIG` / `R-1258-long-TRIG` had `source_text: ""` — executable rules without lineage (found BY the new closure tests) | runtime rule without provenance (forbidden state) | **FIXED** — bound to 2.txt:1279/1280, setup version 1.1.0→1.1.1 |
| text rule → executable predicate | n/a | 503 corpus sentences carry no deterministic predicate; formalizing would require inventing semantics | none — they are knowledge, not code | **NOT BROKEN — BY DESIGN** (section 4) |

## 3. Executable rule audit (counts derived from actual repository state)

Source: `asa-data/brain.db` after `npm run brain:ingest` (2026-09-14), runtime introspection of `COMPILED_STRATEGIES`.

| Metric | Count | Derivation |
|---|---|---|
| Stored rules (registry total) | **534** | `SELECT COUNT(*) FROM rules` |
| — source-text rules | 503 | `rule_class != 'MACHINE_EXECUTABLE_RULE'` (UNFORMALIZED 426, UNKNOWN 75, CLAIM 2) |
| — machine-executable rules | **31** | `rule_class = 'MACHINE_EXECUTABLE_RULE'` |
| Blocked machine rules | 0 | graph `blocked_count` (no compiled rule currently carries `unresolved`; blocked-path is regression-tested with a synthetic node) |
| Candidate rules | 31 | machine rows hold `runtime_status=CANDIDATE` (UNTESTED caps at CANDIDATE — never live) |
| Runtime-consumed rules | 31 | `listRuntimeStrategies().rule_ids` == registered machine rule ids (closure verifier: 31/31, 0 violations) |
| Disabled rules | 503 | every text row `DISABLED` with explicit `non_executable_reason` |
| Live-eligible rules/strategies | **0** | `live_eligible` requires `LIVE_ADVISORY_ONLY` via `runtimeStatusFor` (OOS/walk-forward proof); no strategy holds it |
| Compiled strategy entries | 7 | `COMPILED_STRATEGIES` (6 distinct Brain strategies; STR-RAW-2-1258 has long+short variants) |
| Brain strategy records | 104 | `strategies` table |
| Strategies with compiled binding | 6 | `implementation LIKE 'compiled:%'` |

`executable ≠ live_eligible` is preserved: all 7 compiled entries are
EXECUTABLE/CANDIDATE; zero are live-eligible (empirical gate).

## 4. What a source-text rule is NOT

A rule represented only as text (e.g. `RULE-0001` — «قانون ضد سیستم…»
1.txt:60) is stored with full provenance and governed by
`rule_class=UNFORMALIZED_RULE`, `predicates=[]`, `runtime_status=DISABLED`,
`non_executable_reason="source text carries no deterministic predicate…"`.
Persian cue words (اگر / باید / نباید / ورود / شکست) never produce a
predicate: the mining layer classifies such atoms
(`src/lib/brain/mining/atoms.ts` `classifySemantics`) and only sentences with
both a recognized concept AND a stated quantity become
`EXPLICIT_COMPUTABLE` — and even then no predicate is invented for them
without a hand-authored, source-bound compiled rule.

## 5. Representative lineage chains

### 5.1 COMPLETE — PRZ Bounce (STR-RAW-2-581, long, 1d)

```
source      2.txt:581-597 «نام استراتژی: PRZ Bounce Strategy [VERIFIED]»
  → canonical   StrategyRecord STR-RAW-2-581 (ingest.ts; family level-reaction)
  → rule rows   R-581-LOC / R-581-TRIG / R-581-INVAL
                rule_class=MACHINE_EXECUTABLE_RULE, runtime_status=CANDIDATE
                predicates ["FTR-LEVEL-TOUCH.level.kind == 'support'", …]
                binding {strategy_id, setup_id, stage, consumer: evaluateRuntime}
  → predicate   RulePredicate closures in prz-levels.ts levelRules()
  → features    FTR-LEVELS, FTR-LEVEL-TOUCH (detectLevels/detectLevelTouch)
  → setup       SET-STR-RAW-2-581 (LOCATION→TRIGGER→INVALIDATION)
  → strategy    COMPILED_STRATEGIES[0] → StrategyRuntimeDefinition EXECUTABLE
  → runtime     orchestrator.scanSymbol → evaluateRuntime (advisory)
                brain-scanner / backtest strategy-runner (same path)
  → provenance  every evaluation carries source_refs + features_used + version
```

### 5.2 COMPLETE with explicit direction resolution — AB=CD (STR-RAW-4-2425)

The corpus stores the entry under a generic field reading «ورود به معامله سل»
(4.txt:2434). `compile.ts` flags the direction anomaly; `harmonic-abcd.ts`
resolves it EXPLICITLY to `short` from the stated action; `runtime.ts`
`auditDirection` re-verifies on every build (mismatch ⇒ hard DISABLE, never
inversion). Registry rows R-2425-CTX/LEGS/CORR/SLOPE/FILTER carry the full
chain; the spike-exclusion FILTER blocks on EXPANSION and on unavailable data
(regression-fixed inverse semantics, pinned by tests/remediation.test.ts P0-2).

### 5.3 BROKEN BY DESIGN — text rule (RULE-0001 … RULE-0503)

```
source      1.txt:60 (verbatim, file+line quote stored)
  → rule row   RULE-0001, UNFORMALIZED_RULE, predicates=[]
  → STOP. no predicate exists; no predicate is invented.
     runtime_status=DISABLED, non_executable_reason recorded.
```

### 5.4 BROKEN BY DESIGN — corpus strategies without complete specs (98 records)

```
source      strategy block with critical fields UNKNOWN
  → StrategyRecord runtime_status=DISABLED
  → disabled_reason names exactly which critical fields the corpus never stated
  → STOP. gate.ts forbids promotion while entry/stop/target/timeframe/invalidation are UNKNOWN.
```

## 6. Tri-state audit (TRUE / FALSE / UNKNOWN / CONFLICT)

| Value | Created | Transformed | Consumed |
|---|---|---|---|
| TRUE/FALSE (predicate ok) | `RulePredicate.test` in compiled rules | combined by `evaluateRule` (AND/OR as declared per rule) | `evaluateSetup` stage outcomes |
| UNKNOWN | missing/invalid `FeatureValue` (`valid=false`: INSUFFICIENT_BARS/STALE/UNAVAILABLE) → `evaluateRule` returns UNKNOWN; `FeatureValue` never returns a bare default | stage `combine()` precedence BLOCKED > UNKNOWN > FAIL > PASS; setup final precedence identical | scanner admission (`unknown_required_fields`), score penalties, API explanations. Never collapsed to FALSE — pinned by tests/strategy-engine.test.ts and rule-closure.test.ts |
| BLOCKED | `unresolved` source semantics; invalidation fired; failed exclusion filter | strategy availability NON_COMPUTABLE/DISABLED (`runtime.buildRuntime`) | `evaluateRuntime` returns `{blocked:true, reason}` |
| CONFLICT | corpus `[CONFLICT]` markers → `conflict_groups` (3 groups, all UNRESOLVED); CLAIM/CONFLICT rule classes | gate: unresolved conflict ⇒ ceiling DISABLED | registry rows stay DISABLED; closure verifier rejects any promoted text rule; re-verified post-registration by tests/rule-closure.test.ts |
| throwing predicate | `evaluateRule` catches | degrades to UNKNOWN, never PASS | tests/strategy-engine.test.ts |

Declared graph semantics (`MachineRuleGraph.semantics`) are asserted equal to
actual engine behavior by executed tests — declaration and behavior cannot
drift silently.

## 7. Test evidence

Environment note: sandbox required building `better-sqlite3` against local
Node headers (`node-gyp rebuild --nodedir=/usr/local`); no dependency
versions were changed.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | PASS (0 errors) |
| `npm run lint` | PASS (0 findings) |
| `npx vitest run` | **PASS — 21 files, 449/449 tests** (baseline before milestone: 423/423) |
| `npm run build` | PASS (Next.js production build, all routes) |
| `npm run brain:ingest` | PASS — coverage_ok=true, 9398/9398 lines, 534 rules (503 text + 31 machine) |
| `verifyRuleRegistryClosure` vs live brain | `{checked_nodes:31, checked_rows:31, checked_text_rows:503, violations:[], ok:true}` |

Tests proving the NEW closure behavior (`tests/rule-closure.test.ts`, 26 tests):

- **Provenance:** every graph node/registry row carries verbatim source text + corpus file+line refs.
- **Predicate:** structural predicates (expr + requires) on every node — text alone fails the test.
- **Dependencies:** feature-dependency edges asserted against graph edges.
- **UNKNOWN:** real compiled rule + empty bag ⇒ UNKNOWN with named missing features (matches declared semantics).
- **CONFLICT:** conflict groups remain UNRESOLVED; CONFLICT/UNKNOWN text rules remain DISABLED/unbound after machine registration.
- **Runtime:** `evaluateRuntime` evaluations reference only registered rule ids; blocked definitions refuse evaluation.
- **Negative path:** unresolved-semantics rule projects to DISABLED; tampered registries produce MISSING_REGISTRY_ROW / PREDICATE_MISMATCH / ORPHAN_MACHINE_RULE / BOUND_WITHOUT_PREDICATES / STRATEGY_RULE_IDS_MISMATCH violations; promoted text rule is a violation; registration changes no runtime behavior (identical registry with/without projection).
- Updated `tests/remediation.test.ts` encodes the SAME governance invariant precisely (no predicate-less or non-machine row may ever leave DISABLED) — not weakened.

## 8. Remaining risks (evidence-backed only)

1. **503 source-text rules remain non-executable — by design, permanently until the corpus itself supplies deterministic semantics.** This is honest closure, not a defect; counts are exposed at `/api/brain/rules`.
2. **98 of 104 strategy records stay DISABLED** (critical fields UNKNOWN in source). Promotion requires corpus specification or operator adjudication — the gate forbids invention.
3. **Zero strategies are live-eligible** — no OOS/walk-forward promotion has been persisted (`npm run brain:validate` produces experiments; promotion remains empirical-only).
4. **`[VERIFIED]` markers inside compiled `source_text` for blocks whose corpus lines carry no inline marker (2.txt:1258+, 4.txt:2425+) reflect binder-verified verbatim binding**, an existing convention inherited from prior closure runs; corpus-inline markers and binder markers are not yet distinguished machine-readably.
5. **`scripts/brain-audit.mjs` overwrites `MACHINE_READABLE_STATUS.json`**, which is a hand-maintained/handoff-stamped artifact — restored after this audit run; the overwrite hazard pre-exists this milestone and was left unchanged (scope discipline).

## 9. Final verdict

```
PARTIAL — exact remaining gap: the 503 source-text rules are permanently non-executable
knowledge (no deterministic predicate exists in the corpus for them) and 98/104 strategy
records remain DISABLED at the gate; the machine boundary itself —
Rule Registry → Machine Rule Graph → Compiled Predicate → Setup → Strategy → Runtime
consumer — is now fully implemented, registered, and bidirectionally machine-verified
(31/31 rules, 0 violations), with zero live-eligible strategies (empirical gate intact).
```
