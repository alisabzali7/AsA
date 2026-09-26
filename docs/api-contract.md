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
- **`/api/analysis/{symbol}/{tf}`** returns `{ ok, available, bundle?, overlay?, input }`. `bundle.schema` is `asa.analysis.bundle.v2`: `indicator_status` gives each indicator's state (`OK | INSUFFICIENT_HISTORY | UNDEFINED`, with required bars); `candle_window` is null rather than zero-filled; `structure.trend` ∈ `up | down | range | undetermined` (`undetermined` = not enough swing/EMA50 evidence, never shown as a range); `structure.events` lists causal BOS/CHoCH, each with the broken swing and prior trend; FVG/OB carry mitigation; `momentum` (last-leg slope, thresholds OPEN SPEC) and `divergence` (RSI-only, PARTIAL) come with provenance. `overlay` (`asa.chart.overlay.v1`, `src/lib/chart/technical.ts`) is what the chart draws. The frontend computes no technical object. `input` carries `closed_bars`, `freshness`, `source_ts_ms`, `data_age_ms`, `forming_bar_excluded`, `native`, `derived_source_tf` and `reason`. A venue failure returns **502**; it is never an empty success.
- **`/api/analysis/mtf/{symbol}`** `mtf.verdict` ∈ `UNAVAILABLE | INSUFFICIENT | STALE | ALIGNED | PARTIAL | CONFLICT`, checked in that order. Bias alignment is only computed over fresh, sufficient, same-symbol components. `mtf.components[]` gives per-timeframe state, nativeness and source age. `freshness_verified`, `derived_components` and `oldest_source_ts_ms` are exposed. If all three timeframes fail at the venue, the route returns 502. A role fed a bundle of the wrong timeframe (roles are 4h/1h/15m) gets component state `MISMATCH` and the verdict is `UNAVAILABLE`. An `undetermined` component trend makes the verdict `INSUFFICIENT`; it is not counted as a neutral vote. All components are cut at one as-of instant (`mtf.as_of_ms`), and each series is also cut at its own fetch time.
- **`/api/market/candles`**: `closed_count` counts closed bars. `last_bar_forming`, `source_ts_ms`, `data_age_ms` and `freshness` are added.
- **Stats rows** carry their own venue `timestamp` as `provenance.source_ts_ms`. A future timestamp (more than 60 s of skew) is not trusted. A row whose own timestamp is more than 10 min old is **STALE** even when it was fetched seconds ago (a halted or frozen market). `/api/market/board` rows expose `source_ts_ms`, `source_age_ms` and `state_reason`, and the client only ever *downgrades* the server state.
- **Normalization** (`parseUdfHistory`) rejects null or empty numerics (never coerced to 0), prices ≤ 0, timestamps not aligned to the timeframe, and bars opening after the current forming bar. A payload whose every row is rejected is an **invalid response**: never `no_data`, never an empty series. It never replaces a previously good working series.

## Decision-consumer contract (Team 02 / Task 09)

Team 02 output is **decision-consumable evidence, not a decision**. A consumer can read the following for every technical value:

- **Meaning and calculation.** Indicator values come with `indicator_status[k]` (`OK | INSUFFICIENT_HISTORY | UNDEFINED` plus required bars and reason). Calculation identity is in `provenance.engines` (`structure`, `momentum` = `1.1.0`, `divergence`). `momentum` measures last-leg slope **and** step size (`last_vs_previous_size_ratio`, `last_vs_prior_same_direction_size_ratio`; RAW_4:1193/1196). Its classification is `OPEN_SPECIFICATION`: there is no strong/weak threshold. `divergence` is `PARTIAL` and RSI-only. It is evidence, not a reversal signal and not a confidence score.
- **When it became knowable.** `as_of_t` is the open time (epoch s) of the last **closed** bar. `provenance.source_ts_ms` is that bar's close instant, i.e. when the value became knowable. `stats` (24h change and volume, mark price, funding) is **not** closed-bar data: `provenance.stats_basis = "LIVE_VENUE_SNAPSHOT"`, taken at `provenance.stats_fetched_ms`.
- **Which symbol, timeframe and snapshot it belongs to.** `symbol` and `timeframe` are on every bundle. `provenance.input_fingerprint` is a deterministic 53-bit hex hash of symbol, timeframe, engine versions and every OHLCV field of the closed window. Equal fingerprints mean the same candles went through the same engines. The chart overlay carries `bundle_fingerprint` (and `freshness`). The chart draws an overlay only when that fingerprint matches the bundle it displays.
- **Valid, unknown or unavailable.** `null` always means *not available*. The reason is in `indicator_status`, `structure.reason` or `momentum.reason`. `structure.trend = "undetermined"` means missing evidence and is never neutral. Mitigated FVGs and OBs are historical facts, not active zones.

**Input refusals** (`src/lib/analysis/input.ts`, `reason_code`): `OK | SERIES_UNAVAILABLE | IDENTITY_MISMATCH | UNSUPPORTED_TIMEFRAME | INVALID_SERIES | NO_CLOSED_BARS`. `INVALID_SERIES` covers non-finite, duplicate or out-of-order open times. Such a series is refused, never analysed, because closed-bar trimming requires strictly ascending time.

**Error classes** (`src/lib/analysis/errors.ts`, field `error_class` on `/api/analysis/{symbol}/{tf}`, `/api/analysis/mtf/{symbol}` (also per `inputs[]`) and `/api/ai/analyze`). HTTP status codes are unchanged, except for one new case: an AI request whose trigger fetch failed now returns 502 instead of 409.

| error_class | meaning | HTTP |
|---|---|---|
| `INVALID_REQUEST` | unknown symbol or unsupported timeframe | 400 |
| `MARKET_SOURCE_UNAVAILABLE` | operational universe not discovered yet | 503 |
| `UPSTREAM_FAILURE` | venue request failed (the code cannot know whether it is temporary) | 502 |
| `NO_DATA` | series missing, or no bar has closed yet | 200 `available:false` (AI: 409) |
| `INVALID_SOURCE_DATA` | input refused with `INVALID_SERIES` | 200 `available:false` (AI: 409) |
| `INSUFFICIENT_HISTORY` | bundle present, fields in warmup are listed in `insufficient_history` | 200 `available:true` |
| `INTERNAL_ERROR` | store identity mismatch or unexpected exception (message only, no stack) | 500 (or 200 `available:false` for a mismatch) |

**MTF consumer safety.** Each `mtf.components[]` entry also carries `as_of_t`, `knowable_at_ms` (the component's last close instant) and `input_fingerprint`. When an evaluation instant is set, a component knowable only **after** it gets state `AFTER_AS_OF` and the verdict becomes `UNAVAILABLE` (lookahead refused). A cross-symbol set sets **every** bias to null. Outside `ALIGNED | PARTIAL | CONFLICT`, a per-component bias is only that component's own trend, so read `verdict` first.

**AI consumer (`/api/ai/analyze`).** The evidence is always the core hierarchy (`analyzed_timeframes` = 4h/1h/15m). The route also returns `requested_timeframe` and `mtf_as_of_ms`. `response.data_timestamp` is the source time of the evidence (oldest component close), or `null` when unknown; it is never the reply time. Direction, score and confidence are AI-layer outputs derived only from the MTF verdict. A null or neutral bias never becomes a direction. Annotations show open FVGs only. `invalidation` is a factual structural reference, not a stop.

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

## Task 10 — chart chain, snapshot identity, error classes

**Error classes.** `IDENTITY_MISMATCH` is now a distinct `error_class`. The store returned a series whose symbol/timeframe differs from the request, which is a server fault. `/api/analysis/{symbol}/{tf}` answers **HTTP 500** `{ok:false, available:false, error_class:"IDENTITY_MISMATCH"}`; it previously answered 200 with `INTERNAL_ERROR`. In the MTF route the class is reported per component in `inputs[].error_class`. `INTERNAL_ERROR` now means an unexpected exception only.

**`overlay.series`** (`asa.chart.overlay`): `[{id:"ema20"|"ema50", kind:"EMA", period, label, points:[{t,value}], first_t, source}]`.
- These are the bundle's own per-bar EMA arrays, from the same computation as `bundle.indicators`. The last point equals `indicators.ema20/ema50`.
- Warmup bars are absent, never 0.
- A series that is not aligned to the bundle (length or last bar) is not emitted; it is listed in `omitted` instead.

**Frontend adapter** (`src/lib/chart/adapter.ts`, pure and without an engine import) is the only path from payload to lightweight-charts:
- **Identity gate:** symbol + tf, and the overlay's `bundle_fingerprint` and `as_of_t` must equal the bundle's.
- **Forming bar:** `last_bar_forming` is drawn translucent and outlined.
- **Volume:** the venue's `v` per bar. Bars without a finite `v` are omitted.
- **Precision:** adaptive, about 5 significant digits (2 to 12 decimals).
- **Freshness badge:** shows the server's freshness verdict. When a refresh fails, it says `LAST GOOD`.
- **Poll ordering:** `usePoll` applies a response only if no newer request of the same URL was already applied (`src/lib/poll-sequence.ts`).

**Decision snapshot identity** (`ChartEvidence.snapshot`, opportunity `payload.provenance.data.snapshot`; the two are the same object):
- Fields: `{symbol, timeframe, closed_bars, first_t, as_of_t, knowable_at_ms, engines, input_fingerprint}`.
- The fingerprint function is the bundle's `bundleInputFingerprint`, not a second provenance system. The fields are absent on rows stored before Task 10.
- The `svg`/`png` renderers never draw bars after `snapshot.as_of_t` (falling back to `bar_time`).
- `/api/charts/{id}` JSON adds `snapshot`, `snapshot_check` (`VERIFIED | MISMATCH | UNVERIFIABLE | UNVERIFIABLE_LEGACY_RECORD` with a reason; release-gate added the legacy state) and `decision_bar_t`.
- Telegram withholds the image on `MISMATCH`.

**Detector labelling.**
- `FTR-DOUBLE.neckline_source`: `SWING | BAR_EXTREME`. The old fallback set the neckline to the lower peak. *(Superseded by the absolute-final pass: `SWING | UNKNOWN`, see below.)*
- `FTR-ABCD.slope_bc` is the measured BC slope. `slope_cd` is `null` because CD has not formed at C. The harmonic SLOPE rule compares `slope_bc`, the same value as before, and labels it a proxy.

## Team 02 release-gate additions

Full contract: `docs/team02/technical-evidence-contract.md`. Machine-readable files: `docs/team02/spec-ledger.json` and `docs/team02/consumer-matrix.json`.

- **Overlay** (`/api/analysis/{symbol}/{tf}`) adds `unavailable_layers[]`, which lists spec-missing layers that are never drawn. FIB lines carry `knowable_t`, the leg's confirmation bar.
- **Snapshot check** has a new state, `UNVERIFIABLE_LEGACY_RECORD`, for records with no stored snapshot. `/api/charts/{id}` SVG and PNG responses carry an `X-Snapshot-Check` header.
- **Telegram** sends the photo only for `VERIFIED`, or for a disclosed legacy record.
- **`/api/ai/analyze`**:
  - `response.score` and `response.confidence` are `number | null`. There are no substituted defaults, and unscored MTF verdicts give `null`.
  - New `response.factual_evidence[]` (engine-generated) and `response.semantics` (interpretation fields, evidence origin, score/confidence provenance).
- **Scanner:** `ScanCandidate.snapshot` holds the decision window, formed exactly as the orchestrator forms it.
- **Features:** an ATR-gated feature on a flat series (ATR = 0) now reports `data_quality: "UNAVAILABLE"`. It previously reported `INSUFFICIENT_BARS`.

## Team 02 absolute-final additions

Every item below is a documented contract change. Tests that pinned the older behaviour were updated in the same change, and each update says why.

**Input integrity** (`prepareAnalysisInput`, `reason_code` `INVALID_SERIES`):
- The analysis boundary now applies the venue normaliser's bar rule to every series, including derived, stored, replayed and caller-supplied ones. The shared rule is `domain/candle-validity.ts ohlcvDefect`, which `ttt/udf.ts` and `market/history.ts` also use.
- The whole series is refused, with no repair and no skipped bar, for any of:
  - a non-finite or missing o/h/l/c/v, or a malformed row;
  - a price ≤ 0 or a volume < 0;
  - high/low that do not bound open/close;
  - an open time not aligned to the timeframe;
  - a bar opening after `fetched_at_ms` (a future bar).
- Before this change, NaN/Inf bars reached the engine and only the affected indicators went `UNDEFINED`. The engine's own guards stay in place as defense in depth.
- Bars after an earlier evaluation instant (as-of replay) are still trimmed, not refused.

**HTTP status per input class** (`/api/analysis/{symbol}/{tf}`, `analysis/errors.ts inputHttpStatus`):

| input `reason_code` | `error_class` | HTTP |
|---|---|---|
| OK | `null` or `INSUFFICIENT_HISTORY` | 200 |
| NO_CLOSED_BARS | NO_DATA | 200 `available:false` (legitimate "not yet") |
| SERIES_UNAVAILABLE | NO_DATA | **503** (was 200 `ok:true`) |
| INVALID_SERIES | INVALID_SOURCE_DATA | **502** (was 200 `ok:true`) |
| IDENTITY_MISMATCH | IDENTITY_MISMATCH | 500 |
| UNSUPPORTED_TIMEFRAME | INVALID_REQUEST | 400 |
| venue fetch failed | UPSTREAM_FAILURE | 502 |
| universe not discovered | MARKET_SOURCE_UNAVAILABLE | 503 |

- `AFTER_AS_OF` does not apply to any API route, because no route takes an as-of parameter. It is an MTF component state (`buildMtf`) reported inside a 200 MTF body.
- `UNVERIFIABLE_LEGACY_RECORD` is a chart-evidence state (`/api/charts/{id}` `snapshot_check`, `X-Snapshot-Check`).

**Overlay** (`asa.chart.overlay.v1`, additive plus renamed tokens):
- `zones[].status` is always `"HISTORICAL_ONLY"`. The adapter refuses to draw any other status and counts such zones in `unplaced`.
- `unavailable_layers[].state` token renames:
  - `TRENDLINE_SPEC_UNKNOWN` → `TRENDLINES_SPEC_LOCKED`
  - LIQUIDITY `UNKNOWN` → `LIQUIDITY_SPEC_UNKNOWN`
  - The reasons now cite the corpus lines that were searched.

**Features:**
- `FeatureValue.state` (new) is one of `VALUE | ABSENT | UNDEFINED_ON_DATA | UNAVAILABLE`. It is derived and metadata only; rule outcomes are unchanged:
  - `ABSENT` → the predicate FAILs;
  - `UNDEFINED_ON_DATA` and `UNAVAILABLE` → the rule is UNKNOWN.
- `FTR-DOUBLE.neckline`: `number | null`. `neckline_source`: `SWING | UNKNOWN`.
  - The Task 10 `BAR_EXTREME` fallback, a non-canonical second computation, is removed. When no confirmed opposite swing lies between the peaks, the neckline is `null` / `UNKNOWN`.
  - No production consumer reads the neckline.

**Rules:**
- `RulePredicate.proxy` and `MachineRuleNode.predicates[].proxy` (new, optional) are set when a predicate measures a stand-in for the quantity the source names.
- The harmonic ABCD SLOPE rule declares `{measured: "FTR-ABCD.slope_bc", stands_for: "FTR-ABCD.slope_cd", classification: "ENGINEERING_DEFINED"}`, and its description says PROXY. The comparison is unchanged.

**`/api/ai/analyze`:**
- `response.direction` gains `"unavailable"`:
  - Used when the MTF verdict is `UNAVAILABLE | INSUFFICIENT | STALE`, or macro history is < 100 bars. This applies to both the heuristic and the LLM override.
  - It was `"neutral"`. `"neutral"` now means only "no stance on available evidence" (PARTIAL / CONFLICT).
- `response.semantics.calibration` (new): `CALIBRATION_UNVERIFIED` whenever a score or confidence is produced, `NOT_APPLICABLE` otherwise. It is never "calibrated".

**Frontend precision:**
- The home board and the backtest trade table use the shared `formatPrice` (tick- or significant-digit-aware). They previously used fixed 2/4/6-decimal caps.
- Non-price readouts keep 2 significant digits below 0.01 instead of collapsing to `0.00`.
