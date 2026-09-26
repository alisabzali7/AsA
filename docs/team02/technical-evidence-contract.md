# Team 02 — Technical Evidence Contract

Status as of the release-gate pass (2026-09-26). Machine-readable companions are
`spec-ledger.json` (every rule and its classification) and `consumer-matrix.json`
(every consumer and how it handles identity, freshness and unknowns).

Labels: **SOURCE_DERIVED** (from knowledge/raw, with a line ref) ·
**ENGINEERING_DEFINED** (chosen by engineering, documented) · **UNKNOWN** (no
source spec, nothing implemented instead) · **BLOCKED** · **LEGACY**.

## 1. The chain

```
OHLCV (venue)
 → prepareAnalysisInput(symbol, tf, series, nowMs)       analysis/input.ts
     identity check · timestamp integrity · canonical bar validity
     (domain/candle-validity, shared with ttt/udf + market/history) ·
     future-bar refusal (after fetched_at_ms) · closed-bar cut · freshness
 → buildArtifactsFromInput(input, stats, nowMs)          analysis/bundle.ts
     indicators · ONE swing detection → structure / momentum / divergence
     provenance.input_fingerprint = f(symbol, tf, closed candles, engines)
 → buildMtfAsOf(symbol, {4h,1h,15m}, nowMs)              analysis/mtf.ts
     SAME prepare/build per component (equivalence test)
 → consumers (strategy, orchestrator, AI, chart API, Telegram, SVG/PNG, scanner)
 → buildChartOverlay(bundle, series)                     chart/technical.ts
 → gateAnalysis + overlayToRender                        chart/adapter.ts
 → lightweight-charts (chart-view.tsx), no domain calculation
```

Every value answers four questions: **what** it means (field docs and the
ledger), **when** it is knowable (`as_of_t` is the bar's open; `source_ts_ms`
and `knowable_at_ms` are its close), **which** symbol/tf/snapshot it belongs to
(`input_fingerprint`), and **which state** it is in (`indicator_status`,
`FeatureValue.valid`, `unavailable_layers`, `snapshot_check`).

## 2. Value states

| State | Where | Meaning |
|---|---|---|
| `OK` + value | `indicator_status` | measured on closed bars |
| `INSUFFICIENT_HISTORY` | `indicator_status` | warmup; value is `null`, never 0 |
| `UNDEFINED` | `indicator_status` | mathematically undefined (e.g. volume average 0); `null` with a reason |
| `OK` + convention reason | `indicator_status.rsi14` | flat series: RSI 0/0 reported as 50 by ENGINEERING_DEFINED convention |
| `valid:false` | `FeatureValue` | feature must not be used; `data_quality` describes the **input**, not the feature |
| `state` | `FeatureValue` | `VALUE` · `ABSENT` (computed, nothing found → rule FAIL) · `UNDEFINED_ON_DATA` (data fine, math undefined → rule UNKNOWN) · `UNAVAILABLE` (input insufficient/non-finite → rule UNKNOWN) |
| `UNAVAILABLE` | `FeatureValue.data_quality` | ATR = 0: ATR-scaled tolerance undefined (flat series) |
| `unavailable_layers[]` | overlay | spec missing: TRENDLINES `TRENDLINES_SPEC_LOCKED`; MACD / ICHIMOKU / ADX `PARAMETERS_UNSPECIFIED`; LIQUIDITY `LIQUIDITY_SPEC_UNKNOWN`; MOMENTUM_STRENGTH `MOMENTUM_STRENGTH_THRESHOLD_UNKNOWN` |
| `HISTORICAL_ONLY` | FVG / OB (`overlay.zones[].status`) | unmitigated as of the window end; never "active"; the adapter refuses any other status |
| `proxy` | `RulePredicate` / rule graph | the predicate measures a stand-in (ABCD: `slope_bc` for the not-yet-formed `slope_cd`), ENGINEERING_DEFINED |

## 3. Snapshot identity

- `bundle.provenance.input_fingerprint` equals `overlay.bundle_fingerprint` and
  `mtf.components[].input_fingerprint`.
- Opportunities (orchestrator) and scanner candidates carry a `DecisionSnapshot`
  (`symbol`, `timeframe`, `closed_bars`, `first_t`, `as_of_t`, `knowable_at_ms`,
  `engines`, `input_fingerprint`).
- `verifyDecisionSnapshot` states:
  - `VERIFIED`: the re-fetched window reproduces the fingerprint.
  - `MISMATCH`: the window changed (e.g. a revised bar).
  - `UNVERIFIABLE`: the history no longer holds the window.
  - `UNVERIFIABLE_LEGACY_RECORD`: the record predates snapshot capture, so there is nothing to verify against. Nothing is fabricated.
- Delivery rules:
  - `/api/charts/{id}` returns `snapshot_check` (JSON) and the `X-Snapshot-Check` header (SVG and PNG).
  - Telegram sends the photo only for `VERIFIED`, or for `UNVERIFIABLE_LEGACY_RECORD` with a caption disclosure.

## 4. API (analysis producers)

| Situation | HTTP | `error_class` | Fine-grained field |
|---|---|---|---|
| bundle computed | 200 | `null`, or `INSUFFICIENT_HISTORY` (+ `insufficient_history[]`) | `input.reason_code = OK` |
| series missing | **503** | `NO_DATA` | `SERIES_UNAVAILABLE` |
| no bar closed yet | 200 `available:false` | `NO_DATA` | `NO_CLOSED_BARS` |
| invalid bar / timestamps / future bar | **502** | `INVALID_SOURCE_DATA` | `INVALID_SERIES` |
| store returned another symbol/tf | 500 | `IDENTITY_MISMATCH` | `IDENTITY_MISMATCH` |
| venue request failed | 502 | `UPSTREAM_FAILURE` (retryability UNKNOWN) | `error` text |
| MTF: all three components failed | 502 | `UPSTREAM_FAILURE` | per-component `inputs[]` |
| MTF: some components failed | 200 | per component | per-component `reason_code` |
| unsupported timeframe / unknown symbol | 400 | `INVALID_REQUEST` | (`UNSUPPORTED_TIMEFRAME` at input level) |
| universe not discovered (TTT unreachable) | 503 | `MARKET_SOURCE_UNAVAILABLE` | `universe.state` |
| unexpected exception | 500 | `INTERNAL_ERROR` | message only, no stack |
| AI route, no data | 409 / 502 | `NO_DATA` / `UPSTREAM_FAILURE` | |

Notes:
- There is no hidden fallback and no compute-time substitution: `data_timestamp` and `source_ts_ms` are source times.
- Absolute-final: one status table, `analysis/errors.ts inputHttpStatus`, pinned by tests. `SERIES_UNAVAILABLE` (503) and `INVALID_SERIES` (502) are no longer 200 `ok:true`.
- `AFTER_AS_OF` does not apply at the API: no route takes an as-of parameter. It is an MTF component state.

## 5. AI: fact versus interpretation

- `factual_evidence[]` is generated only by the engine (`factualEvidence(ev)`),
  whichever provider answered. It carries tf, as-of, freshness and fingerprint.
- `semantics.interpretation_fields` lists every AI-layer field.
- `semantics.evidence_origin` is `ENGINE` (heuristic) or
  `PROVIDER_INTERPRETATION` (LLM).
- `semantics.score_provenance` is one of:
  - `ENGINEERING_DEFINED_UNCALIBRATED`: heuristic ALIGNED 62 / PARTIAL 48 / CONFLICT 25.
  - `PROVIDER_SELF_REPORTED_UNCALIBRATED`.
  - `NOT_PRODUCED`: score `null`. An INSUFFICIENT / STALE / UNAVAILABLE MTF verdict is never a score of 0, and a missing LLM score is never 50.
- The heuristic produces no confidence (`confidence: null`).
- `semantics.calibration` is `CALIBRATION_UNVERIFIED` for any produced score or confidence, and `NOT_APPLICABLE` otherwise.
- `direction`:
  - `unavailable`: MTF UNAVAILABLE / INSUFFICIENT / STALE, for the heuristic and as an LLM override.
  - `neutral`: no stance on available evidence.
  - `reject`: risk block.
  - UNAVAILABLE is never neutral.

## 6. Web chart

- **Draws only the server overlay:** S/R and fib price lines; FVG/OB as time-bounded segments from `from_t` to `as_of_t`, labelled at the start bar; BOS/CHoCH/divergence markers; a "fib leg confirmed" marker at the leg's `knowable_t`; EMA series.
- **Gates:** identity, fingerprint and as-of gates. Late responses are rejected by the sequence guard (browser scenario 4 now proves this with a genuinely delayed response).
- **Failure handling:** a failed refresh shows `<freshness> · LAST GOOD` (scenario 6b).
- **Deferred:** strategy markers are not built. Status `DEFERRED_STRATEGY_MARKERS_WEB`; see the ledger for the dependency.

## 7. Open specifications (not implemented, by design)

- MACD, Ichimoku and ADX parameters.
- Trendlines.
- Liquidity.
- Momentum strength threshold.
- FVG/OB active and mitigation semantics beyond "historical".
- ABCD alternation and corrections over 100%.
- Upstream retryability.
