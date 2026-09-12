> **HISTORICAL AUDIT RECORD.** Written during a previous remediation run and
> retained as evidence. Any commit hash, count or 48-symbol figure below
> describes THAT run. Current truth: `FINAL_STATUS.md` /
> `MACHINE_READABLE_STATUS.json`.

# Known Defects Resolved

| # | Sev | Defect | Root cause | Fix | Verification |
|---|---|---|---|---|---|
| 1 | P0 | Production universe was the static 48 | board/stats/store/engine/candles/psychology imported `LEGACY_UNIVERSE` | new `operational-universe.ts` derived from TTT discovery; all 7 modules rewired | live: board & stats return **63** rows incl. XAUUSDT/NVDAUSDT |
| 2 | P0 | Discovery ran after catalog ingest | boot ordering | `refreshOperationalUniverse(true)` moved before `getMarkets()`/`sweepStats()`; 10-min re-discovery interval | ordering test asserts index positions |
| 3 | P0 | Harmonic filter inverted | predicate returned `ok: spike`, so EXPANSION *passed* | returns `ok: !spike`; missing data no longer permits the trade | 5 tests incl. end-to-end BLOCKED |
| 4 | P0 | `precisions` mis-typed | code read `.price`/`.quantity`; TTT sends `["0.1","1","0.01"]` | `parsePrecisions()` + `decimalsFromStep()` handle array, object, garbage | price precision now resolves (was always null) |
| 5 | P0 | `min_qty = stepSize` | step is an increment, not a minimum | `min_qty` = UNAVAILABLE | test asserts `min_qty !== step_size` |
| 6 | P0 | `min_notional` from tier-0 | tier-0 lower bound is not an order minimum | UNAVAILABLE; raw value kept as `first_tier_min_notional` | test |
| 7 | P0 | `settlement_asset = quoteAsset` | inference | null unless TTT sends it | test |
| 8 | P0 | `contract_type` hardcoded `PERPETUAL` | assumption | `UNAVAILABLE` unless TTT states it | test both ways |
| 9 | P0 | 1D fallback masked outages | bare `catch` | `isUnsupportedResolution()`; timeout/5xx/auth/rate-limit/network **rethrow** | 5 tests |
| 10 | P0 | Chart had no progressive history | fixed 400/700 request | `loadOlder()` paging, dedupe, boundary badge | 5 tests + named concepts |
| 11 | P1 | Reference harness in production graph | `registry.ts` imported it | moved to `tests/fixtures/strategy/`; **zero** production references | 2 tests |
| 12 | P1 | 503 rules overclaimed | blanket `SOURCE_VERIFIED` + `CANDIDATE`, empty predicates | `rule_class` + `non_executable_reason`; all DISABLED; only 149 verified | 5 tests |
| 13 | P1 | Engineering params looked like source rules | no origin metadata | `policy/origin.ts` registry + validation invariant + API | 5 tests |
| 14 | P1 | Stale Postgres/Drizzle refs, dead `DATABASE_URL` | leftovers | removed | scan test |
| 15 | P1 | "48-Symbol Universe" UI copy (en+fa) | stale | "TTT Market Universe" / "جهان بازار TTT" | scan test |
| 16 | P1 | Handoff could contain the nested ZIP | incomplete exclusions | excluded `*.zip`, WAL/SHM, `.next`, `.npm`; SHA256 emitted | packager: forbidden **NONE** |
