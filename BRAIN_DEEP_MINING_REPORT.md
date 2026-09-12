# AsA — Brain Deep Mining Report

**Problem:** the original extraction was marker-driven. It only saw blocks
introduced by `نام استراتژی:` and similar field labels — 87 declarations — and
ignored the far larger body of narrative teaching.

**Measured in the corpus:** 969 «اگر» (if), 1,193 «باید» (must), 235 «نباید»
(must-not), 1,182 «ورود» (entry), 614 «شکست» (break). Marker extraction saw
almost none of it.

## Result

| Layer | Before | After |
|---|---|---|
| Extraction basis | field markers only | full narrative mining |
| Knowledge atoms | — | **8,591** |
| Computable atoms | — | **643** |
| Reusable components | — | **621** (277 computable) |
| Generated candidates | — | **55** (all DISABLED) |

### Atoms by kind
{
 "NARRATIVE": 4644,
 "LOCATION": 601,
 "RISK": 441,
 "PSYCHOLOGY": 340,
 "ENTRY": 298,
 "PROHIBITION": 280,
 "TRIGGER": 269,
 "STOP_MODEL": 253,
 "OBLIGATION": 230,
 "EXIT": 208,
 "CONFIRMATION": 203,
 "TARGET_MODEL": 191,
 "CONDITION": 186,
 "FILTER": 175,
 "EXAMPLE": 127,
 "PROCESS": 48,
 "SECURITY": 44,
 "CONTEXT": 33,
 "INVALIDATION": 20
}

### Components by role
{
 "location": 163,
 "entry": 92,
 "filter": 86,
 "confirmation": 78,
 "trigger": 71,
 "target": 52,
 "stop": 47,
 "context": 19,
 "invalidation": 13
}

## Strategy counts — reported SEPARATELY (§B4)

| Count | Value |
|---|---|
| explicit_source_strategy_count (executable) | 6 |
| brain_strategy_records | 104 |
| source_derived_strategy_count | 0 |
| candidate_strategy_count (engine-generated) | 55 |
| disabled_strategy_count | 153 |
| process_count | 48 |
| psychology_count | 340 |
| risk_policy_count | 8 |
| security_count | 44 |

**Process, psychology and security atoms are NOT strategies** and are never
counted as such.

## Uncertainty preserved

CLAIM 240 · CONFLICT 128 ·
UNKNOWN 598 · INFERRED 171

## Semantic honesty (§D)

Only **643** of 8,591 atoms are
`EXPLICIT_COMPUTABLE` — a concept a detector can supply AND a stated quantity.
Everything else is classified honestly:

- «کمی پایین‌تر» / «بالای ناحیه» / «متناسب با موج» / «سقف قبلی» →
  `EXPLICIT_NON_COMPUTABLE`, **no number invented**
- instructor claims → `CLAIM`, never executable
- `[CONFLICT]` → `CONFLICT`, never executed
- absence of a `[VERIFIED]` marker → `SOURCE_INFERRED`, **never** verified

## Three precision bugs found and fixed while mining

1. **`\b` does not work on Persian script.** `/\bاگر\b/` matched nothing, so
   969 conditional sentences were invisible. CONDITION atoms went 91 → 186.
2. **«اشباع خرید» (overbought) was read as a BUY direction.** Overbought argues
   for a *short*. Compound market-state terms are now stripped first.
3. **Economic prose mined as price levels.** "monthly income of $2000 …
   حمایتی" matched support-resistance. Both the concept pattern and a
   non-market numeric filter now exclude it.

## Corpus integrity

5 files · 9,398 lines ·
1,412,928 chars. Relocated to `knowledge/raw/` with
**identical sha256** — verified by re-ingest.

**RAW_1/RAW_2/RAW_4 TRUNCATED_UPSTREAM at 350000 chars; complete originals unavailable**
