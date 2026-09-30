# AsA Brain — Self Audit

Generated 2026-09-30T07:48:53.689Z from `./asa-data/brain.db`. Every number below is read from
stored evidence; nothing is asserted without a record behind it.

## 1. Source recovery and supplied-text inventory

Source recovery manifest: **PARTIAL**; sha256=d54ccd6627dda3fac9173f7fda66f8817768607a072a3850233491a3506ed3c5.
The canonical knowledge pack is an index/acceleration artifact, not authority over the raw source bytes.

| file id | filename | lines | chars | bytes | sha256 (12) | completeness |
|---|---|---:|---:|---:|---|---|
| 1.txt | RAW_1.txt | 2450 | 349998 | 617254 | `b430f52e191c` | **TRUNCATED** |
| 2.txt | RAW_2.txt | 1987 | 350000 | 598290 | `0177294c7f5b` | **TRUNCATED** |
| 3.txt | RAW_3.txt | 1100 | 253714 | 424438 | `bf0ae22b7fdb` | **UNKNOWN** |
| 4.txt | RAW_4.txt | 2901 | 350000 | 600086 | `bc050e2aefbb` | **TRUNCATED** |
| 5.txt | RAW_5.txt | 960 | 109216 | 184218 | `1c73c915fe90` | **UNKNOWN** |
| USER-PSY-1 | USER_PSYCHOLOGY_1.txt | 2423 | 349991 | 624394 | `31e52de9d6f6` | **TRUNCATED** |
| USER-PSY-2 | USER_PSYCHOLOGY_2.txt | 640 | 90370 | 160655 | `485fa4f9afb4` | **TRUNCATED** |

Total 12461 lines / 1853289 chars across 7 ingested text sources.
One fragment per supplied source line: **VERIFIED**
(12461 fragments for 12461 lines).

> **TRUNCATED:** 5 source file(s) are explicitly marked incomplete (1.txt, 2.txt, 4.txt, USER-PSY-1, USER-PSY-2); missing continuation is not reconstructed.
> **UNKNOWN:** 2 source file(s) have unknown original completeness (3.txt, 5.txt); below-cap size is not treated as proof of completeness.

## 2-3. Fragments and knowledge items
- NARRATIVE: 9595
- UNKNOWN_MARKER: 649
- RISK: 624
- SECTION_HEADER: 482
- PSYCHOLOGY: 322
- RULE_CANDIDATE: 252
- CLAIM: 241
- CONFLICT_MARKER: 174
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

## 5. Compiled strategy contracts and runtime status

Brain registry status: {"DISABLED":103,"CANDIDATE":1}. Implementation-bound records: 6.
Source contract version: 1.2.0; status counts: {"INCOMPLETE":6}.
**Source-faithful executable contracts:** 0. A code binding or formalized record is not source parity.

| strategy | contract | source completeness | runtime ceiling | promotion | live | blockers |
|---|---|---|---|---|---|---:|
| `STR-RAW-2-581` | INCOMPLETE | PARTIAL | RESEARCH_ONLY | NO | NO | 5 |
| `STR-RAW-2-803` | INCOMPLETE | PARTIAL | RESEARCH_ONLY | NO | NO | 7 |
| `STR-RAW-2-926` | INCOMPLETE | PARTIAL | RESEARCH_ONLY | NO | NO | 6 |
| `STR-RAW-2-1258` | INCOMPLETE | PARTIAL | RESEARCH_ONLY | NO | NO | 5 |
| `STR-RAW-4-2425` | INCOMPLETE | PARTIAL | RESEARCH_ONLY | NO | NO | 5 |
| `STR-RAW-4-2449` | INCOMPLETE | PARTIAL | RESEARCH_ONLY | NO | NO | 5 |

Compiled definitions may remain research-computable only. Incomplete/unknown source contracts are not live executable or promotion eligible; see the field-level source-contracts.json blockers.

## 6-8. Unknowns, conflicts, claims
- UNKNOWN-marked source lines: 649
- Conflict groups: 4 (4 unresolved)
- Claims held at UNTESTED: 553
- Quarantined commentary (never executable): 46

## 9. Empirical validation status — two deliberate views, one contract

**Registry view** (`empirical_validation`, view `strategy_registry`, source:
`strategies.empirical_status`, governed state — changes only via the
promotion path):
{
  "view": "strategy_registry",
  "source": {
    "table": "strategies",
    "column": "empirical_status",
    "scope": "every strategy registry row",
    "aggregation": "count_by_status"
  },
  "backtested": 0,
  "oos": 0,
  "walk_forward": 0,
  "robust": 0,
  "rejected": 0,
  "untested": 104,
  "total": 104,
  "semantics": "GOVERNED registry state: the empirical_status STORED on each strategy row. It changes only through the governed promotion path — it is NEVER auto-copied from experiment rows and NEVER inferred from source_status. SOURCE_VERIFIED != EMPIRICALLY_VALIDATED.",
  "relationship_to_phase2": "Deliberately different view from `phase2`: this section reports what the REGISTRY governs; `phase2.empirical_by_strategy` reports what EXPERIMENT rows observed. A divergence (registry UNTESTED while experiments show BACKTESTED) is expected, not a contradiction — see `empirical_semantics`.",
  "note": "empirical_status is never inferred from source_status"
}

**Experiment-store view** (`phase2`, view `experiment_store`, source:
`experiments.empirical_status`, raw observed verdicts before governance,
weakest of newest-per-symbol):
- experiments stored: 0
- (no experiments stored — run `npm run brain:validate`)
- promoted to live (derived from registry): 0

**Why the two views differ by design** (`empirical_semantics`, contract v1.0.0):
- SOURCE_VERIFIED != EMPIRICALLY_VALIDATED: source strength never implies test evidence.
- BACKTESTED != OOS_TESTED != WALK_FORWARD != ROBUST: each ladder step requires strictly stronger evidence; a weaker label never implies a stronger one.
- UNKNOWN != PASS: missing evidence blocks promotion; it is never upgraded to a pass.
- Experiment rows NEVER auto-promote the strategy registry; the registry changes only via the governed promotion path.
- `phase2` statuses are raw RECORDED verdicts; the promotion gate (src/lib/backtest/promotion.ts) re-derives every row under the current criteria and may reach a weaker status.

> EXPECTED divergence, not a contradiction: validation runs were observed (BACKTESTED evidence exists for those symbols) but no governed promotion has rewritten the registry row. Trust `phase2` for what was OBSERVED and `empirical_validation` for what the registry GOVERNS.

## 10. Disabled strategies — exact reasons
- 4× critical spec fields are UNKNOWN in source: stop, target, invalidation
- 73× source_status=SOURCE_NAMED
- 98× no executable implementation binding
- 103× empirical_status=UNTESTED
- 1× compile: critical source fields NOT_PRESENT: stop, target, exit, one or more critical sour
- 1× critical spec fields are UNKNOWN in source: stop, target, timeframe
- 2× compile: critical source fields explicitly UNKNOWN: timeframe, stop, target, one or more c
- 9× critical spec fields are UNKNOWN in source: stop, target, timeframe, invalidation
- 4× compile: critical source fields explicitly UNKNOWN: timeframe, stop, target, exit, one or
- 59× critical spec fields are UNKNOWN in source: entry, stop, target, timeframe, invalidation
- 1× source_status=UNKNOWN
- 7× compile: critical source fields NOT_PRESENT: timeframe, entry, stop, target, exit, SOURCE_
- 1× critical spec fields are UNKNOWN in source: target, invalidation
- 2× compile: critical source fields NOT_PRESENT: target, exit, critical source fields explicit
- 2× critical spec fields are UNKNOWN in source: stop, timeframe
- 1× compile: critical source fields explicitly UNKNOWN: timeframe, stop, one or more critical
- 1× critical spec fields are UNKNOWN in source: stop, target
- 1× compile: critical source fields explicitly UNKNOWN: stop, target, one or more critical sou
- 7× compile: critical source fields NOT_PRESENT: exit, critical source fields explicitly UNKNO
- 1× critical spec fields are UNKNOWN in source: stop
- 1× compile: critical source fields explicitly UNKNOWN: stop, one or more critical source fiel
- 3× compile: critical source fields NOT_PRESENT: timeframe, stop, target, exit, SOURCE_SPEC_ON
- 2× compile: critical source fields explicitly UNKNOWN: stop, target, exit, one or more critic
- 1× critical spec fields are UNKNOWN in source: stop, invalidation
- 3× critical spec fields are UNKNOWN in source: stop, timeframe, invalidation
- 1× compile: critical source fields NOT_PRESENT: timeframe, exit, critical source fields expli
- 5× critical spec fields are UNKNOWN in source: entry, stop, target, invalidation
- 2× compile: critical source fields explicitly UNKNOWN: entry, stop, target, exit, one or more
- 1× compile: critical source fields NOT_PRESENT: target, critical source fields explicitly UNK
- 2× compile: critical source fields NOT_PRESENT: timeframe, stop, target, exit, critical sourc
- 1× critical spec fields are UNKNOWN in source: entry, target, timeframe
- 1× compile: critical source fields explicitly UNKNOWN: timeframe, entry, target, one or more
- 1× critical spec fields are UNKNOWN in source: entry, stop, timeframe
- 1× compile: critical source fields explicitly UNKNOWN: timeframe, entry, stop, one or more cr
- 2× compile: critical source fields explicitly UNKNOWN: timeframe, stop, exit, one or more cri
- 1× compile: critical source fields NOT_PRESENT: stop, target, exit, critical source fields ex
- 4× critical spec fields are UNKNOWN in source: timeframe, invalidation
- 1× compile: critical source fields NOT_PRESENT: timeframe, exit, critical source fields inclu
- 3× critical spec fields are UNKNOWN in source: timeframe
- 3× compile: critical source fields explicitly UNKNOWN: timeframe, one or more critical source
- 1× critical spec fields are UNKNOWN in source: invalidation
- 1× compile: critical source fields NOT_PRESENT: entry, stop, target, exit, critical source fi
- 1× critical spec fields are UNKNOWN in source: target
- 1× compile: critical source fields explicitly UNKNOWN: target, one or more critical source fi

## 11. Missing implementation areas
- 6 compiled strategy contract(s) are not source-faithful executable; see source_contracts.json blockers. A TypeScript implementation binding alone is not source parity.
- No compiled source contract is currently promotion- and live-eligible.
- 2 supplied source file(s) have UNKNOWN completeness; below-cap byte counts do not prove completion.
- 5 supplied source file(s) are explicitly TRUNCATED; missing continuation is not reconstructed.
- No experiment rows are persisted in this Brain DB; empirical status remains UNTESTED.

## 12-13. Runtime capabilities / TTT capability matrix
- MEASURED: FTR-FUNDING, FTR-OI, FTR-BOOK-IMB
- DERIVED: 15 features
- PROXY (labeled, never presented as measured): FTR-TAPE-FLOW
- UNAVAILABLE (declared with reason, never fabricated):
  - FTR-LIQ: no documented public TTT liquidation endpoint
  - FTR-LSR: not exposed by verified public TTT interface
  - FTR-CVD: requires verified aggressor semantics TTT does not document

## 14. Risk policy matrix
| policy | per-trade | daily | account | period | source status | source completeness | conflict | runtime | production selectable |
|---|---|---|---|---|---|---|---|---|---|
| RISK-2PCT-PER-TRADE | 2 | — | — | — | CONFLICT | {"1.txt":"TRUNCATED"} | CFG-RISK-PCT | CANDIDATE | NO |
| RISK-1PCT-PER-TRADE | 1 | — | — | — | CONFLICT | {"5.txt":"UNKNOWN","4.txt":"TRUNCATED"} | CFG-RISK-PCT | CANDIDATE | NO |
| RISK-2PCT-POSITION-CAP | 2 | — | — | — | CONFLICT | {"4.txt":"TRUNCATED"} | CFG-RISK-PCT | CANDIDATE | NO |
| RISK-DAILY-5PCT | — | 5 | — | — | SOURCE_VERIFIED | {"4.txt":"TRUNCATED"} | — | CANDIDATE | NO |
| RISK-ACCOUNT-11PCT | — | — | — | — | CLAIM | {"4.txt":"TRUNCATED"} | CFG-ACCOUNT-RISK-CONTEXT | DISABLED | NO |
| RISK-PERIOD-15PCT | — | — | — | 15 | SOURCE_VERIFIED | {"4.txt":"TRUNCATED"} | — | CANDIDATE | NO |
| RISK-TOLERANCE-5PCT | 5 | — | — | — | CLAIM | {"4.txt":"TRUNCATED"} | CFG-RISK-PCT | DISABLED | NO |
| RISK-ASA-CONSERVATIVE-DEFAULT | 1 | 5 | 11 | 15 | SOURCE_INFERRED | {} | — | CANDIDATE | NO |

Production-selectable policies: **0 / 8**. Eligibility requires valid source-contract identity, identity-bound byte/hash/line/character matches, exact quoted excerpts and in-range references, COMPLETE cited documents, no unresolved conflict, source status SOURCE_VERIFIED, and non-disabled runtime status. Explicit operator selection is a separate requirement. Eligibility blockers by policy:
- RISK-2PCT-PER-TRADE: source status is CONFLICT, not SOURCE_VERIFIED; linked to unresolved source conflict CFG-RISK-PCT; source 1.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-1PCT-PER-TRADE: source status is CONFLICT, not SOURCE_VERIFIED; linked to unresolved source conflict CFG-RISK-PCT; source 5.txt completeness is UNKNOWN; production selection requires COMPLETE; source 4.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-2PCT-POSITION-CAP: source status is CONFLICT, not SOURCE_VERIFIED; linked to unresolved source conflict CFG-RISK-PCT; source 4.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-DAILY-5PCT: source 4.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-ACCOUNT-11PCT: source status is CLAIM, not SOURCE_VERIFIED; linked to unresolved source conflict CFG-ACCOUNT-RISK-CONTEXT; runtime status is DISABLED; source 4.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-PERIOD-15PCT: source 4.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-TOLERANCE-5PCT: source status is CLAIM, not SOURCE_VERIFIED; linked to unresolved source conflict CFG-RISK-PCT; runtime status is DISABLED; source 4.txt completeness is TRUNCATED; production selection requires COMPLETE
- RISK-ASA-CONSERVATIVE-DEFAULT: source status is SOURCE_INFERRED, not SOURCE_VERIFIED; no exact source references

The competing per-trade percentages are preserved as separate policies. No average was taken. A CLAIM or SOURCE_INFERRED row is not promoted into a numeric limit.

## 15. Psychology policy matrix
| policy | effect | penalty | source status | source completeness | effective runtime | overridable | eligibility |
|---|---|---|---|---|---|---|---|
| PSY-DAILY-LOSS | BLOCK | 0 | SOURCE_VERIFIED | {"4.txt":"TRUNCATED"} | DISABLED | no | runtime status is DISABLED; source 4.txt completeness is TRUNCATED; production selection requires COMPLETE |
| PSY-REVENGE | BLOCK | 0 | SOURCE_INFERRED | {"4.txt":"TRUNCATED"} | DISABLED | no | source status is SOURCE_INFERRED, not SOURCE_VERIFIED; runtime status is DISABLED; source 4.txt completeness is TRUNCATED; production selection requires COMPLETE |
| PSY-COOLDOWN | BLOCK | 0 | SOURCE_INFERRED | {} | DISABLED | yes | source status is SOURCE_INFERRED, not SOURCE_VERIFIED; no exact source references; runtime status is DISABLED |
| PSY-CHASE | REDUCE_SCORE | 15 | SOURCE_INFERRED | {} | DISABLED | yes | source status is SOURCE_INFERRED, not SOURCE_VERIFIED; no exact source references; runtime status is DISABLED |
| PSY-OVERTRADE | REDUCE_SCORE | 10 | SOURCE_INFERRED | {} | DISABLED | yes | source status is SOURCE_INFERRED, not SOURCE_VERIFIED; no exact source references; runtime status is DISABLED |
| PSY-CHECKLIST | REQUIRE_CHECKLIST | 0 | SOURCE_VERIFIED | {} | DISABLED | no | no exact source references; runtime status is DISABLED |
| PSY-REVIEW | FLAG | 0 | SOURCE_VERIFIED | {} | DISABLED | yes | no exact source references; runtime status is DISABLED |
| PSY-STANDARDS | FLAG | 0 | SOURCE_VERIFIED | {} | DISABLED | no | no exact source references; runtime status is DISABLED |
| PSY-EMOTIONAL-STATE | BLOCK | 0 | SOURCE_VERIFIED | {} | DISABLED | no | no exact source references; runtime status is DISABLED |
| PSY-SECURITY | FLAG | 0 | SOURCE_VERIFIED | {} | DISABLED | no | no exact source references; runtime status is DISABLED |

## 16. AI Clone boundary (route-level audit)

A provider request (only when the selected provider is configured and online) contains exactly two chat messages: the deterministic system prompt and a user message containing the bounded question, deterministic facts and serialized structured context. There is no prior chat history; transport includes the selected model, temperature 0.2 and stream=false. The route returns facts and the same context separately from the explanation. The actual mock-provider request is compared with the returned context in tests/ai-clone.test.ts.

Always-sent context includes validated-symbol market stats/provenance/freshness or board sweep truth, release/build and source-contract identity, all compiled contracts and runtime consumer paths, promotion status, selected-or-blocked risk-policy state/source completeness, configured risk inputs, measured advisory-signal exposure or UNKNOWN, realized-loss availability/reason, and market-psychology context for a valid symbol. The request-scoped personal-psychology branch adds only explicit/journal-derived state, its deterministic gate result, manifest/source descriptors and source-only principle paraphrases; otherwise those archives are marked NOT_SHARED and omitted. Raw source transcript bytes, free-text journal notes, reconstructed historical psychology, inferred traits/diagnoses and provider credentials are excluded.

The response includes ok, bounded question, validated symbol, provider_mode, facts, ai_context, explanation, explanation_authority, explanation_validation, tags, llm_online, provider/model/status/error/latency metadata, and ts. Provider prose can only populate candidate explanation text and influence its token/authority validation findings and model-output-related status/tag. It cannot mutate the facts, context, risk/promotion/admission state or runtime decisions. A narrow numeric/symbol/authority-token check may withhold it; **semantic truth is NOT_PROVEN**. The explanation is rendered separately and is never consumed by strategy, risk, promotion, persistence, live gates or order code. Deterministic evidence remains authoritative; AI Clone has no execution capability.

## 17. Safety invariants
{
  "execution_endpoints_present": false,
  "execution_note": "TTT transport refuses non-GET/HEAD at the source; no order/position/transfer path exists",
  "live_strategies": 0,
  "fabricated_market_fields": 0,
  "unavailable_fields_declared": 3
}
