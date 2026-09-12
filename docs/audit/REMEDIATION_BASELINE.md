> **HISTORICAL AUDIT RECORD.** Written during a previous remediation run and
> retained as evidence. Any commit hash, count or 48-symbol figure below
> describes THAT run. Current truth: `FINAL_STATUS.md` /
> `MACHINE_READABLE_STATUS.json`.

# Remediation Baseline — measured, not assumed

Captured at the START of this run, from the actual workspace.

| Fact | Measured value |
|---|---|
| HEAD at baseline | `8461050` |
| package version | `6.0.0` |
| node_modules present | **NO** — `npm ci` required |
| vitest available | **NO** before install; available after (`npm ci` = 16s) |
| test declarations | 340 `it/test` across 18 files |
| tests executed at baseline | 340 passed / 0 failed |
| brain.db | 503 rules, all `predicates=[]`, all `SOURCE_VERIFIED` + `CANDIDATE` |
| TTT markets (live) | 63 |
| production universe | **STATIC 48** in board/stats/store/engine/candles/psychology |
| handoff ZIP | absent; prior run reported 2.16 MB |

## Defects confirmed against the live repository

1. **P0** board/stats/store/engine/candles/psychology iterate `LEGACY_UNIVERSE` (48).
2. **P0** harmonic filter returns `ok: spike` — EXPANSION *passes* instead of blocking.
3. **P0** `precisions` typed as an object; TTT actually returns `["0.1","1","0.01"]`.
4. **P0** `min_qty = stepSize`, `settlement = quoteAsset`, `contract_type` hardcoded.
5. **P0** `getDailyCandles` bare `catch` turns any outage into synthetic 1D.
6. **P0** chart requests 400/700 candles with no progressive loading.
7. **P1** `registry.ts` imports the reference harness into the production graph.
8. **P1** 503 rules overclaim `SOURCE_VERIFIED` + `CANDIDATE`.
9. **P1** stale `Postgres`/`Drizzle` references and "48-Symbol Universe" UI copy.

## Corrections to prior reports

- The audit's "367 test declarations" counted `describe` blocks; the real figure
  is **340 `it/test`**, all executed.
- "npm ci timed out / vitest unavailable" was environment-specific: `npm ci`
  completes in **16 s** here and vitest runs.
