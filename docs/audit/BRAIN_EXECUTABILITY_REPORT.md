# Brain Executability Report

**Path B implemented:** rules that cannot be safely formalized stay textual, and
the executable subset is explicit and machine-auditable.

| Metric | Value |
|---|---|
| Machine-executable rules | **31** (compiled strategies) |
| Stored source-text rules | **503** |
| Runtime candidates among stored | **0** |

### Stored rules by governance class
{
 "UNFORMALIZED_RULE": 426,
 "UNKNOWN": 75,
 "CLAIM": 2
}

### Stored rules by source status
{
 "SOURCE_INFERRED": 277,
 "SOURCE_VERIFIED": 149,
 "UNKNOWN": 75,
 "CLAIM": 2
}

## What changed

Before: all 503 rows were `SOURCE_VERIFIED` + `CANDIDATE` with empty predicates —
overclaiming twice (absence of a `[VERIFIED]` marker is not verification, and a
rule with no predicate is not a candidate).

After: every row carries a `rule_class` and a `non_executable_reason`, every row
is `DISABLED`, and only **149** rows are
genuinely `SOURCE_VERIFIED` (those that actually carry the marker).

The **31** machine-executable rules live in the compiled
strategies, each with a real predicate and real feature dependencies, exposed at
`/api/brain/rules`.

## Strategy counts (never conflated)
{
 "explicit_source_strategy_count": 6,
 "brain_strategy_records": 104,
 "source_derived_strategy_count": 0,
 "candidate_strategy_count": 55,
 "disabled_strategy_count": 153,
 "process_count": 48,
 "psychology_count": 340,
 "risk_policy_count": 8,
 "security_count": 44,
 "note": "process/psychology/security atoms are NOT strategies and are never counted as such"
}

Knowledge atoms mined from narrative: **8,591**.
