# API Contract (v1, JSON, defensive parsing)

Groups:
- SYSTEM: GET /api/system/health | /api/system/status | /api/system/events (GET json ?limit=; SSE ?stream=1) | /api/system/config (GET/POST sections risk|ai|general) | /api/system/config/risk (GET/POST) | /api/system/config/ai (GET/POST) | /api/system/logs
- MARKET: GET /api/market/symbols | /prices | /candles?symbol&tf&limit&focus=1 | /trades?symbol | /stats?symbol? | /board | /coverage | /orderbook?symbol&refresh=1 | /derivatives?symbol | /deriv_features
- ANALYSIS: GET /api/analysis/{symbol}/{tf} (typed IntelligenceBundle) | POST /api/ai/analyze {symbol, timeframe}
- AI: GET /api/ai/status | POST /api/ai-clone {question, symbol}
- PSYCHOLOGY: GET /api/psychology/summary
- FUNDAMENTAL: GET /api/fundamental/news?days&symbol&kind
- OPPORTUNITIES: GET /api/opportunities
- SIGNALS: GET /api/signals | GET /api/signals/{id} | GET/POST /api/signals/journal | DELETE /api/signals/journal/{idOrOpp}
- RESEARCH: GET /api/research/hypotheses | /api/research/strategies | /api/research/ai-calls | POST /api/research/backtest | GET /api/research/backtest/{job_id}
- CHARTS: GET /api/charts/{sigIdOrOppId}.json (final merged annotation spec shared by web + Telegram)

Conventions: unavailable → `{ available: false, state, reason }`; never `0` for unknown; freshness as ages + RTTs in every payload; states from the state taxonomy (CONNECTING/CONNECTED/LIVE/DEGRADED/STALE/UNAVAILABLE/NOT_CONFIGURED/INSUFFICIENT_DATA/ERROR/READY/REJECTED/COOLDOWN).

Market runtime: TTT discovery is the production universe source. While discovery is `NOT_READY`, `NETWORK_FAILURE`, or `INVALID_RESPONSE`, symbol-validating market/analysis routes return `ok:false` with HTTP 503 and machine-readable `universe`/`state` metadata; they do not relabel a symbol as invalid and do not fall back to the legacy regression set. `/api/market/board` and `/api/market/prices` include `universe` metadata on success and return 503 when no discovered universe exists. Focus-lane surfaces (`/trades`, `/orderbook`) return `{ available:false, state:"UNAVAILABLE", reason }` until their lane has actually measured data.

Write protection: if `ASA_API_TOKEN` is set, mutating routes (config POST, journal POST/DELETE, ai analyze, ai-clone) require header `x-asa-token`. Local default: open (documented), token recommended on shared machines/VPS.

Versioning: additive-only within v1; breaking changes under new route suffix.

## Market-truth semantics (Team 01 / Task 03)

- **Closed bars only for analysis.** TTT UDF series end with the still-forming bar. Every analysis producer (`/api/analysis/*`, `/api/ai/analyze`, the live scanner via `scanSymbol`) goes through `src/lib/analysis/input.ts` (`prepareAnalysisInput`), which removes the forming bar, checks the series really is the requested symbol/timeframe, and works out freshness.
- **Freshness is source age.** `source_ts_ms` = the close time of the last closed bar. `data_age_ms` = now − `source_ts_ms`. `freshness` is `FRESH | STALE | UNAVAILABLE`, and a series is STALE after 2 bar-periods. `age_ms` / `series_age_ms` are **retrieval** ages only.
- **`/api/analysis/{symbol}/{tf}`** returns `{ ok, available, bundle?, input }`. `input` carries `closed_bars`, `freshness`, `source_ts_ms`, `data_age_ms`, `forming_bar_excluded`, `native`, `derived_source_tf` and `reason`. A venue failure returns **502**; it is never an empty success.
- **`/api/analysis/mtf/{symbol}`** `mtf.verdict` ∈ `UNAVAILABLE | INSUFFICIENT | STALE | ALIGNED | PARTIAL | CONFLICT`, checked in that order. Bias alignment is only computed over fresh, sufficient, same-symbol components. `mtf.components[]` gives per-timeframe state, nativeness and source age. `freshness_verified`, `derived_components` and `oldest_source_ts_ms` are exposed. If all three timeframes fail at the venue, the route returns 502.
- **`/api/market/candles`**: `closed_count` counts closed bars. `last_bar_forming`, `source_ts_ms`, `data_age_ms` and `freshness` are added.
- **Stats rows** carry their own venue `timestamp` as `provenance.source_ts_ms`. A future timestamp (more than 60 s of skew) is not trusted. A row whose own timestamp is more than 10 min old is **STALE** even when it was fetched seconds ago (a halted or frozen market). `/api/market/board` rows expose `source_ts_ms`, `source_age_ms` and `state_reason`, and the client only ever *downgrades* the server state.
- **Normalization** (`parseUdfHistory`) rejects null or empty numerics (never coerced to 0), prices ≤ 0, timestamps not aligned to the timeframe, and bars opening after the current forming bar. A payload whose every row is rejected is an **invalid response**: never `no_data`, never an empty series. It never replaces a previously good working series.

## Opportunity / signal / delivery (Team 01 / Task 04)

- **Decision ≠ delivery.** A published signal is an immutable snapshot of an admitted opportunity. Outbox state (`QUEUED`/`FAILED`/`SENT`/`DEAD`) is read live from `telegram_outbox` and cannot mutate market truth, opportunity state, or recreate the signal.
- **Admission** requires setup `PASS`, fresh closed-bar native series, explicit risk `pass`, portfolio `pass`, psychology not `block`, no unknown required fields, and (live) `LIVE_ADVISORY_ONLY`. Missing risk is `unavailable`, never a pass. Missing daily PnL / open book is not coerced to 0.
- **`GET /api/opportunities`**: `state` is the persisted decision (`READY`/`REJECTED`/…). `fresh`/`freshness` is the 4-bar anchor window of the opportunity's own timeframe. `actionable` is true only when `state === READY` AND the anchor is still inside that window. Freshness `READY` on a `REJECTED` row is not an upgrade.
- **Idempotency**: opportunity id = sha1(symbol|tf|direction|setup|anchor). One opportunity → one signal row → one outbox row. Scanner retries, overlapping scans of the same bar, and process restart cannot enqueue a second delivery. Different bars do not join an in-flight scan of an older bar.
- **Chart evidence** must match the opportunity's symbol/timeframe/direction or the chart route returns 409; Telegram never attaches a picture from a mismatched identity.
