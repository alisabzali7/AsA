# API Contract (v1, JSON, defensive parsing)

Groups:
- SYSTEM: GET /api/system/health | /api/system/status | /api/system/events (GET json ?limit=; SSE ?stream=1) | /api/system/config (GET; POST {section: risk|ai|general, ...values} — sections are a POST body field, there are NO /config/{section} sub-paths) | /api/system/logs | POST /api/system/notify
- MARKET: GET /api/market/symbols | /prices | /candles?symbol&tf&limit&focus=1 | /trades?symbol | /stats?symbol? | /board | /catalog | /focus?symbol | /matrix | /sync-status | /history?symbol&tf&sync=full | /orderbook?symbol&refresh=1 | /derivatives?symbol
- ANALYSIS: GET /api/analysis/{symbol}/{tf} (typed IntelligenceBundle) | POST /api/ai/analyze {symbol, timeframe}
- AI: GET /api/ai/status | POST /api/ai-clone {question, symbol}
- PSYCHOLOGY: GET /api/psychology/summary
- FUNDAMENTAL: GET /api/fundamental/news?days&symbol&kind
- OPPORTUNITIES: GET /api/opportunities
- SIGNALS: GET /api/signals | GET /api/signals/{id} | GET/POST /api/signals/journal | DELETE /api/signals/journal/{idOrOpp}
- RESEARCH: GET /api/research/strategies | /api/research/ai-calls | POST /api/research/backtest | GET /api/research/backtest/{id}
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

## Market-truth semantics (Team 01 / Task 06 — closure addendum)

- **Engine health is source-aware.** `GET /api/system/health` and `marketEngine.status().health` report `LIVE` only when the stats sweep is recent **and** at least one measured venue row has a live source timestamp. When every measured row's own `timestamp` has stopped moving (venue freeze), health is `STALE` with reason `sweeps succeeding but all N measured venue row timestamp(s) are stale` — fetch success alone never declares LIVE. Before the first successful sweep the state stays `CONNECTING`, and the reason carries the measured consecutive-failure count and last error instead of a bare "pending". The age ladder is unchanged: LIVE < 30 s · STALE < 2 min · DEGRADED < 10 min · UNAVAILABLE beyond.
- **Boundary flag is proof-gated.** `metadata.earliest_boundary_reached` on `/api/market/history` is true only when `completion_state === COMPLETE_TO_TTT_BOUNDARY` **and** `boundary_proof` is recorded. A legacy row with a retained completion flag but no recorded evidence keeps its `completion_state` but never announces a proven boundary to the chart.
- **`metadata.discovery_degraded`** is `DISCOVERY_UNAVAILABLE` when the route served a symbol from persisted evidence while live TTT discovery was down (restart-during-outage recovery). Such reads are `ok:true` but never presented as discovery-validated; a symbol with no persisted evidence still returns 503 `DISCOVERY_UNAVAILABLE`, and a permanently excluded symbol is always 400.
- **Sync cells expose their evidence.** `/api/market/sync-status` and `/api/market/matrix` cells carry `boundary_proof` (`TTT_NO_DATA` or null), `boundary_proof_ms`, `last_successful_sync_ms`, `last_error` and `retrieval_version`, so a completion flag is always readable together with the evidence behind it.
- **Same-cell syncs are serialized.** `syncHistory()` runs one critical section per (symbol, timeframe) in FIFO order: concurrent callers (chart `sync=full` + backtest `sync=full`) can no longer interleave read-prior → walk → write, which previously let a failing caller erase a fresh `TTT_NO_DATA` proof or let a stale writer label an unproven extent complete. Different cells still sync concurrently.
- **The dashboard health chip reads the endpoint it names.** The `health endpoint` metric renders `/api/system/health`'s `market` state (client-elapsed downgrade only). SSE socket connectivity is reported separately as `SSE on/off` and is never presented as market health.

## Opportunity / signal / delivery (Team 01 / Task 04)

- **Decision ≠ delivery.** A published signal is an immutable snapshot of an admitted opportunity. Outbox state (`QUEUED`/`FAILED`/`SENT`/`DEAD`) is read live from `telegram_outbox` and cannot mutate market truth, opportunity state, or recreate the signal.
- **Admission** requires setup `PASS`, fresh closed-bar native series, explicit risk `pass`, portfolio `pass`, psychology not `block`, no unknown required fields, and (live) `LIVE_ADVISORY_ONLY`. Missing risk is `unavailable`, never a pass. Missing daily PnL / open book is not coerced to 0.
- **`GET /api/opportunities`**: `state` is the persisted decision (`READY`/`REJECTED`/…). `fresh`/`freshness` is the 4-bar anchor window of the opportunity's own timeframe. `actionable` is true only when `state === READY` AND the anchor is still inside that window. Freshness `READY` on a `REJECTED` row is not an upgrade.
- **Idempotency**: opportunity id = sha1(symbol|tf|direction|setup|anchor). One opportunity → one signal row → one outbox row. Scanner retries, overlapping scans of the same bar, and process restart cannot enqueue a second delivery. Different bars do not join an in-flight scan of an older bar.
- **Chart evidence** must match the opportunity's symbol/timeframe/direction or the chart route returns 409; Telegram never attaches a picture from a mismatched identity.
