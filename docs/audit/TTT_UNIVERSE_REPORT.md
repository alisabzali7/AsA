# TTT Universe Report

| Fact | Value |
|---|---|
| Production universe source | **`ttt-dynamic`** (discovered at runtime) |
| Markets | **63** |
| Discovery complete | True |
| TONUSDT present | **False** |
| Legacy 48 | test-only `LEGACY_48_REGRESSION_SET` |

## Chain proven live

`/futures/markets` → `normalizeMarket` → `ASA_MARKET_ELIGIBLE` →
`operationalUniverse()` → engine · store · board · stats · candles · scanner.

Verified on the running server:

- `/api/market/symbols` → 63, `source: ttt-dynamic`
- `/api/market/board` → **63 rows** including `XAUUSDT`, `NVDAUSDT`
- `/api/market/stats` → **63 rows**
- `/api/market/candles?symbol=XAUUSDT` → `ok: true`, 50 bars
- `/api/analysis/XAUUSDT/1h` → 200
- TONUSDT → **400** on candles, analysis and history

## Boot ordering

`refreshOperationalUniverse(true)` runs **before** `getMarkets()` and
`sweepStats()`, so a newly listed contract is registered before any loop can
filter it out. A 10-minute `discovery` interval picks up post-boot listings
without a restart.
