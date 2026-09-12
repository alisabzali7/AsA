# Testing Guide

Run: `npm ci && npx vitest run`

No database server or env var is required: suites that need the Brain build it
from `knowledge/raw/` (`npm run brain:ingest && npm run brain:mine`), and those
that need candles use the committed replay fixtures under
`tests/fixtures/replay/`.

Coverage (389 tests, 19 files):
- `ttt-signer` — algorithm vector (independently computed), method upper-casing, ms timestamp, lowercase-hex
- `universe-tf` — LEGACY_48_REGRESSION_SET membership, TONUSDT exclusion, TF normalization, native-vs-derived 1D labeling, documented resolutions
- `udf-normalize` — duplicated-final-timestamp dedupe (last wins), sorting, malformed-row rejection, non-ok status, 8H→1D derivation
- `indicators` — EMA lag/convergence, RSI extremes, ATR constant-vol, ADX warmup
- `structure` — swing detection, BOS/trend classification, annotation geometry inside the data window
- `risk` — sizing math, minRR veto, liquidation-inside-stop veto, ESTIMATE labeling
- `retention` — 30d policy text, gap counting without bridging, closed-candle bucket logic
- `scheduler` — adaptive budget invariants and priority queues
- `no-fake-scan` — production source scan: no prohibited venues, no PRNG/faker, no order-execution code paths

Live integration (not mocked): verified manually against the real TTT API (markets, stats, orderbook, funding-history, UDF per resolution, quote-rates, 401 behavior on auth routes) and recorded in this build's delivery notes. Fixture-based backtests are marked FIXTURE in their output context and never presented as edge proof.
