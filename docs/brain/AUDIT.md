# AsA Brain — Self Audit

Generated 2026-09-16T09:50:22.421Z from `./asa-data/brain.db`. Every number below is read from
stored evidence; nothing is asserted without a record behind it.

## 1. Corpus coverage
| file | lines | chars | sha256 (12) | truncated upstream |
|---|---|---|---|---|
| 1.txt (RAW_1.txt) | 2450 | 349998 | `b430f52e191c` | **YES** |
| 2.txt (RAW_2.txt) | 1987 | 350000 | `0177294c7f5b` | **YES** |
| 3.txt (RAW_3.txt) | 1100 | 253714 | `bf0ae22b7fdb` | no |
| 4.txt (RAW_4.txt) | 2901 | 350000 | `bc050e2aefbb` | **YES** |
| 5.txt (RAW_5.txt) | 960 | 109216 | `1c73c915fe90` | no |

Total 9398 lines / 1412928 chars.
One fragment per source line: **VERIFIED**
(9398 fragments for 9398 lines).

> **Honest limitation.** 3 files (1.txt, 2.txt, 4.txt) end mid-sentence at the upstream 350,000-character cap. That content is absent from the supplied package and has **not** been reconstructed from model knowledge.

## 2-3. Fragments and knowledge items
- NARRATIVE: 6782
- UNKNOWN_MARKER: 649
- SECTION_HEADER: 482
- RISK: 470
- RULE_CANDIDATE: 247
- PSYCHOLOGY: 246
- CLAIM: 239
- CONFLICT_MARKER: 161
- STRATEGY_DECL: 76
- META_COMMENTARY: 46

Knowledge items: 104

## 4. Rules
534 rule records in one registry, two governed populations:
- **31 MACHINE_EXECUTABLE_RULE** rows — the compiled runtime's
  rules, registered by ingest with structural predicates, feature dependencies,
  corpus provenance and an explicit binding (`strategy_id`, `setup_id`, stage,
  consumer `evaluateRuntime`). Only this class may drive runtime evaluation.
- **503 source-text rules**, each with file+line provenance.
  None carries a machine predicate, so every one remains DISABLED with an explicit
  `non_executable_reason` (`missing_fields` names exactly what is absent).

Closure: `verifyRuleRegistryClosure` (src/lib/strategy/rule-graph.ts) checks the
registry against the runtime in BOTH directions — a drifted predicate, a missing
row, an orphan machine row or a promoted text rule is a machine-detectable violation.

## 5. Strategies
By runtime status: {"DISABLED":98,"CANDIDATE":6}
By family: {"multi-indicator":2,"process-layer":8,"reversal":12,"level-reaction":21,"discretionary-framework":14,"trend-following":15,"pullback":3,"breakout":9,"momentum-continuation":3,"divergence":2,"smc-ob":9,"market-structure":3,"harmonic":3}
Executable specs (all five critical fields present in source): **6**
- `STR-RAW-2-581` PRZ Bounce Strategy (level-reaction) → CANDIDATE
- `STR-RAW-2-803` پرایس اکشن سطوح نامرئی (level-reaction) → CANDIDATE
- `STR-RAW-2-926` استراتژی ۴-خطی (برگشت از نواحی PRZ) (level-reaction) → CANDIDATE
- `STR-RAW-2-1258` استراتژی معاملاتی دو قله و دو دره بر اساس نواحی PRZ (level-reaction) → CANDIDATE
- `STR-RAW-4-2425` هارمونیک پایه (AB=CD) (harmonic) → CANDIDATE
- `STR-RAW-4-2449` هارمونیک پایه معکوس (harmonic) → CANDIDATE

## 6-8. Unknowns, conflicts, claims
- UNKNOWN-marked source lines: 649
- Conflict groups: 3 (3 unresolved)
- Claims held at UNTESTED: 553
- Quarantined commentary (never executable): 46

## 9. Empirical validation status
{
  "backtested": 0,
  "oos": 0,
  "walk_forward": 0,
  "robust": 0,
  "untested": 104,
  "note": "empirical_status is never inferred from source_status"
}

## 10. Disabled strategies — exact reasons
- 2× critical spec fields are UNKNOWN in source: stop, target, invalidation
- 98× no executable implementation binding
- 98× empirical_status=UNTESTED
- 2× compile: stop UNKNOWN in source, target UNKNOWN in source, no exit/invalidation stated in 
- 2× critical spec fields are UNKNOWN in source: stop, target, timeframe
- 3× compile: timeframe UNKNOWN in source, stop UNKNOWN in source, target UNKNOWN in source
- 8× critical spec fields are UNKNOWN in source: stop, target, timeframe, invalidation
- 8× compile: timeframe UNKNOWN in source, stop UNKNOWN in source, target UNKNOWN in source, no
- 59× critical spec fields are UNKNOWN in source: entry, stop, target, timeframe, invalidation
- 10× compile: timeframe UNKNOWN in source, no entry condition stated in source, stop UNKNOWN in
- 1× critical spec fields are UNKNOWN in source: target, invalidation
- 1× compile: target UNKNOWN in source, no exit/invalidation stated in source
- 5× critical spec fields are UNKNOWN in source: stop, timeframe
- 4× compile: timeframe UNKNOWN in source, stop UNKNOWN in source
- 3× critical spec fields are UNKNOWN in source: stop, target
- 3× compile: stop UNKNOWN in source, target UNKNOWN in source
- 1× critical spec fields are UNKNOWN in source: stop
- 1× compile: stop UNKNOWN in source
- 1× critical spec fields are UNKNOWN in source: stop, invalidation
- 1× compile: stop UNKNOWN in source, no exit/invalidation stated in source
- 3× critical spec fields are UNKNOWN in source: entry, stop, target
- 5× compile: no entry condition stated in source, stop UNKNOWN in source, target UNKNOWN in so
- 1× critical spec fields are UNKNOWN in source: entry, target, timeframe
- 1× compile: timeframe UNKNOWN in source, no entry condition stated in source, target UNKNOWN 
- 1× critical spec fields are UNKNOWN in source: entry, stop, timeframe
- 2× critical spec fields are UNKNOWN in source: entry, stop, target, invalidation
- 5× critical spec fields are UNKNOWN in source: timeframe
- 5× compile: timeframe UNKNOWN in source
- 2× critical spec fields are UNKNOWN in source: timeframe, invalidation
- 2× compile: timeframe UNKNOWN in source, no exit/invalidation stated in source
- 1× critical spec fields are UNKNOWN in source: invalidation
- 1× compile: no exit/invalidation stated in source
- 1× critical spec fields are UNKNOWN in source: target
- 1× compile: target UNKNOWN in source

## 11. Missing implementation areas
- 98 strategies have no executable spec because the corpus left critical fields UNKNOWN (see disabled_reasons)
- No OOS/walk-forward validation has been run yet, so no strategy can leave CANDIDATE.
- 3 source files are truncated upstream; content beyond 350k chars is unavailable.

## 12-13. Runtime capabilities / TTT capability matrix
- MEASURED: FTR-FUNDING, FTR-OI, FTR-BOOK-IMB
- DERIVED: 15 features
- PROXY (labeled, never presented as measured): FTR-TAPE-FLOW
- UNAVAILABLE (declared with reason, never fabricated):
  - FTR-LIQ: no documented public TTT liquidation endpoint
  - FTR-LSR: not exposed by verified public TTT interface
  - FTR-CVD: requires verified aggressor semantics TTT does not document

## 14. Risk policy matrix
| policy | per-trade | daily | account | period | source | conflict | runtime |
|---|---|---|---|---|---|---|---|
| RISK-2PCT-PER-TRADE | 2 | — | — | — | CONFLICT | CFG-RISK-PCT | CANDIDATE |
| RISK-1PCT-PER-TRADE | 1 | — | — | — | CONFLICT | CFG-RISK-PCT | CANDIDATE |
| RISK-2PCT-POSITION-CAP | 2 | — | — | — | CONFLICT | CFG-RISK-PCT | CANDIDATE |
| RISK-DAILY-5PCT | — | 5 | — | — | SOURCE_VERIFIED | — | CANDIDATE |
| RISK-ACCOUNT-11PCT | — | — | 11 | — | SOURCE_VERIFIED | — | CANDIDATE |
| RISK-PERIOD-15PCT | — | — | — | 15 | SOURCE_VERIFIED | — | CANDIDATE |
| RISK-TOLERANCE-5PCT | 5 | — | — | — | CLAIM | CFG-RISK-PCT | DISABLED |
| RISK-ASA-CONSERVATIVE-DEFAULT | 1 | 5 | 11 | 15 | SOURCE_INFERRED | — | CANDIDATE |

The competing per-trade percentages are preserved as separate policies. No average was taken.

## 15. Psychology policy matrix
| policy | effect | penalty | runtime | overridable |
|---|---|---|---|---|
| PSY-DAILY-LOSS | BLOCK | 0 | LIVE_ADVISORY_ONLY | no |
| PSY-REVENGE | BLOCK | 0 | LIVE_ADVISORY_ONLY | no |
| PSY-COOLDOWN | BLOCK | 0 | LIVE_ADVISORY_ONLY | yes |
| PSY-CHASE | REDUCE_SCORE | 15 | LIVE_ADVISORY_ONLY | yes |
| PSY-OVERTRADE | REDUCE_SCORE | 10 | LIVE_ADVISORY_ONLY | yes |
| PSY-CHECKLIST | REQUIRE_CHECKLIST | 0 | LIVE_ADVISORY_ONLY | no |
| PSY-REVIEW | FLAG | 0 | LIVE_ADVISORY_ONLY | yes |
| PSY-STANDARDS | FLAG | 0 | LIVE_ADVISORY_ONLY | no |
| PSY-EMOTIONAL-STATE | BLOCK | 0 | LIVE_ADVISORY_ONLY | no |
| PSY-SECURITY | FLAG | 0 | LIVE_ADVISORY_ONLY | no |

## 16. AI inputs/outputs
AI consumes deterministic context only (candles, features, structure, strategy
evaluations, risk output, psychology output, capability matrix, source refs) and must
label every assertion MEASURED / SOURCE / INFERRED / CLAIM / UNKNOWN / UNAVAILABLE /
CONFLICT. AI can never override risk limits, psychology blocks, data availability, or
runtime status.

## 17. Safety invariants
{
  "execution_endpoints_present": false,
  "execution_note": "TTT transport refuses non-GET/HEAD at the source; no order/position/transfer path exists",
  "live_strategies": 0,
  "fabricated_market_fields": 0,
  "unavailable_fields_declared": 3
}
