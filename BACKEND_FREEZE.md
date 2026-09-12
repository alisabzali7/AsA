# AsA — BACKEND FREEZE

**Freeze timestamp:** 2026-09-09
**Commit:** `f4f6da5` (tag `backend-freeze-v1`)
**App version:** `asa@6.0.0` · **Build id:** `<app_version>+<git_commit>` (from `src/lib/release.ts`)
**Status:** 30/30 acceptance gates PASS · 0 PARTIAL · 0 BLOCKED · 0 FAIL

The backend is CLOSED. No further trading features, strategies or source-semantic
changes may be made without a versioned, migrated change.

---

## 1. Source of truth

| Concern | Owner | Notes |
|---|---|---|
| Executable strategies | `src/lib/strategy/runtime.ts` | the ONLY production registry |
| Corpus knowledge | `asa-data/brain.db` | rebuildable from `uploads/RAW_1..5.txt` |
| Runtime state | `asa-data/asa.db` | opportunities, signals, outbox, news |
| Experiments | `experiments` table in `brain.db` | append-only, immutable |
| Market truth | TheTrueTrade only | host allow-list enforced |

`src/lib/strategy/reference.ts` is a TEST HARNESS ONLY, reachable via
`getReferenceHarness()`. A test asserts no production file imports it.

## 2. Strategy / setup architecture

```
Brain StrategyRecord
  -> StrategyRuntimeDefinition   (src/lib/strategy/runtime.ts)
    -> SetupDefinition           (src/lib/rules/setup.ts)
      -> RuleDefinition[]        (src/lib/rules/engine.ts)
        -> RulePredicate[]
          -> FeatureValue        (src/lib/features/detectors.ts)
            -> SourceRef         (file + line in the immutable corpus)
```

**Counts (authoritative):** brain strategies **104** · runtime strategies **6** ·
setups **7** · executable setups **7** · disabled setups **0**.
The 6→7 difference is `STR-RAW-2-1258`, which compiles a long *and* a short branch
because the corpus states separate entry conditions per direction.

Pipeline order (identical in advisory and backtest):
`data freshness → MTF → prerequisites → features → rules → setup → psychology → risk → portfolio → score → admission`

## 3. Frontend integration endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/brain` | corpus coverage, counts, honest limitations |
| `GET /api/brain/strategies` | 104-strategy registry with runtime status + why |
| `GET /api/brain/explorer` | strategy dossier / source window / full-text search |
| `GET /api/brain/rules` | executable rule registry with predicates |
| `GET /api/brain/trace` | machine-readable dependency trace + capability report |
| `GET /api/brain/unknowns` | everything the corpus left unspecified |
| `GET /api/brain/policies` | risk + psychology registries, conflict groups |
| `GET /api/brain/validation` | empirical evidence and promotion state |
| `GET /api/opportunities` | stored opportunities |
| `GET /api/charts/{id}` | chart evidence JSON (annotations + lineage) |
| `GET /api/charts/{id}.svg` | annotated SVG |
| `GET /api/charts/{id}.png` | annotated PNG (same image Telegram sends) |
| `POST /api/research/backtest` | run a backtest (mutation — auth required) |
| `GET /api/system/status` | health, TTT budget, AI/Telegram/news state |

**Auth:** mutations require `x-asa-token` (or `Authorization: Bearer`). In production
a missing `ASA_API_TOKEN` denies every mutation with **503** (fail-closed).

## 4. Key schemas

**Opportunity** — `symbol, timeframe, direction, strategy_id, setup_id, score,
score_breakdown, score_semantics, entry_zone, stop, targets, rr, invalidation, risk,
psychology, portfolio, data_quality, positive_factors, negative_factors,
blocked_factors, unknown_factors, contradictions, source_refs, chart_evidence,
state, provenance, anchor_ts_ms`

**ChartEvidence** — `symbol, timeframe, strategy_id, setup_id, direction, bar_time,
annotations[], rules[], score, score_semantics, assumptions[], lineage_complete`
Each annotation: `annotation_id, kind, label, price, produced_by{type,id},
source_refs[], detector_version, evidence_kind`

**FeatureValue** — `feature_id, value, valid, data_quality, reason, timeframe,
timestamp, inputs[], bars_used, detector_version, source_refs[]`

**RuleEvaluation** — `rule_id, outcome(PASS|FAIL|BLOCKED|UNKNOWN), explanation,
predicate_results[], missing_features[], features_used[], source_refs[], timeframe,
evaluated_at_ms`

**Experiment** — `experiment_id, dataset_fingerprint, ttt_source, symbol, timeframe,
from_ts, to_ts, bars, strategy_version, rule_version, detector_version,
risk_policy_id, psychology_policy_set, app_version, build_id, code_version, costs,
params(+regime), in_sample, oos, walk_forward, promotion, empirical_status`

**Error** — `{ ok: false, error: string, reason?: string, hint?: string }` with an
HTTP status: 400 bad input · 401 bad token · 404 missing · 409 conflict/insufficient
data · 503 unavailable or fail-closed auth.

## 5. Data-quality semantics

`FRESH | STALE | UNAVAILABLE | INSUFFICIENT_BARS`. Staleness budget = 2 closed bars
of the strategy's own timeframe. A stale or gapped dependency yields `UNKNOWN`
or `BLOCKED` — never a silent pass.

## 6. Environment variables (NAMES ONLY)

`TTT_BASE_URL` `TTT_API_KEY` `TTT_API_SECRET` `ASA_DB_PATH` `ASA_BRAIN_DB_PATH`
`ASA_CORPUS_DIR` `ASA_API_TOKEN` `ASA_RISK_POLICY_ID` `ASA_SCORE_THRESHOLD`
`ASA_RISK_ACCOUNT_EQUITY` `ASA_RISK_PER_TRADE_PCT` `ASA_RISK_MAX_LEVERAGE`
`AI_PROVIDER` `AI_BASE_URL` `AI_API_KEY` `AI_MODEL` `OPENAI_API_KEY`
`TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` `TELEGRAM_DRY_RUN` `NEWS_RSS_URL`
`NEWS_POLL_MIN` `ASA_GIT_COMMIT` `ASA_BUILD_ID` `ASA_ALLOW_UNAUTHENTICATED`

No values are shipped. **Rotate TTT, AI and Telegram credentials before deploying.**

## 7. TTT boundary

Allow-list: `apiv2.thetruetrade.io`, `thetruetrade.io`. No fallback exchange.
Market requests are **unsigned** — the venue edge returns 403 for any request
carrying `X-API-Key`, including routes that return 200 unsigned.

**Permanently UNAVAILABLE** (never fabricated): liquidations (`FTR-LIQ`),
long/short ratio (`FTR-LSR`), CVD (`FTR-CVD`). Tape flow (`FTR-TAPE-FLOW`) is
**PROXY** — aggressor semantics are unverified. Funding is not modelled in replay.

## 8. No-execution invariant

Four enforced layers: transport type (`GET | HEAD` only) · host allow-list ·
static source scan (12 execution patterns) · central `assertNoExecutionCapability()`.
Absent capabilities: place/cancel order, close/modify position, set leverage,
add/remove margin, transfer, withdraw. **The human is the only executor.**

## 9. Empirical strategy status at freeze

| strategy | setups | empirical status | experiments | symbols |
|---|---|---|---|---|
| `STR-RAW-2-581` | 1 | UNTESTED | 8 | 3 |
| `STR-RAW-2-803` | 1 | UNTESTED | 24 | 9 |
| `STR-RAW-2-926` | 1 | UNTESTED | 24 | 9 |
| `STR-RAW-2-1258` | 2 | UNTESTED | 48 | 9 |
| `STR-RAW-4-2425` | 1 | BACKTESTED | 24 | 9 |
| `STR-RAW-4-2449` | 1 | BACKTESTED | 24 | 9 |

**152 experiments · ZERO promoted to LIVE_ADVISORY_ONLY.** No strategy has passed
the OOS gate. Nothing may go live without persisted OOS + walk-forward evidence.

## 10. Frozen contracts

Do not change without a version bump and migration: DB schemas, the opportunity /
chart-evidence / experiment payloads, promotion criteria, risk-policy semantics,
the dynamic TTT market-discovery contract, and the no-execution invariant.
