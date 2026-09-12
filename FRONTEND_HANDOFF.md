# AsA — Frontend Handoff Contract

**Backend is FROZEN.** The frontend consumes these APIs and must never recreate
strategy, risk, psychology, scoring or market-truth logic.

All endpoints return JSON. Read endpoints are `GET`. Mutations require
`x-asa-token` (or `Authorization: Bearer …`) and **fail closed with 503** in
production when `ASA_API_TOKEN` is unset.

---

## 1. Endpoint index

### Market data
| Endpoint | Purpose |
|---|---|
| `GET /api/market/catalog` | dynamic TTT catalog · `?refresh=1` `?symbol=` `?eligible=1` |
| `GET /api/market/matrix` | symbol × timeframe availability · `?symbols=` `?synced=1` |
| `GET /api/market/history` | full-range candles · `?symbol= &tf= &from= &to= &limit= &sync=1\|full &gaps=1` |
| `GET /api/market/sync-status` | data-layer observability |
| `GET /api/market/candles` | live hot window (board/ticker) |
| `GET /api/market/stats` `…/board` `…/orderbook` `…/trades` | live market surfaces |

### Brain / knowledge
| Endpoint | Purpose |
|---|---|
| `GET /api/brain` | corpus coverage, counts, honest limitations |
| `GET /api/brain/strategies` | 104-record registry · `?family= &runtime= &q=` |
| `GET /api/brain/explorer` | `?strategy=` dossier · `?file=&line=` source window · `?q=` search |
| `GET /api/brain/rules` | executable rule registry · `?predicates=1` |
| `GET /api/brain/trace` | dependency trace + feature capability |
| `GET /api/brain/mining` | knowledge atoms, components, generated candidates |
| `GET /api/brain/unknowns` | everything the corpus left unspecified |
| `GET /api/brain/policies` | risk + psychology registries, conflict groups |
| `GET /api/brain/validation` | empirical evidence · `?strategy=` for experiments |

### Decisions
| Endpoint | Purpose |
|---|---|
| `GET /api/opportunities` | stored opportunities |
| `GET /api/charts/{id}` | chart evidence JSON · `?bars= &from= &to=` |
| `GET /api/charts/{id}.svg` / `.png` | annotated image (same evidence Telegram sends) |
| `GET /api/signals` · `/api/signals/journal` | advisory signals, journal |
| `POST /api/research/backtest` | run a backtest (**mutation**) |
| `GET /api/system/status` · `/health` · `/logs` | health |

## 2. Core schemas

**Opportunity**
```
symbol, timeframe, direction, strategy_id, setup_id, score, score_breakdown,
score_semantics, entry_zone{top,bottom}, stop, targets[], rr, invalidation,
risk{verdict,reasons,numbers}, psychology{state,hard_blocks[],soft_warnings[],score_modifier},
portfolio{verdict,reasons,unenforced[]}, data_quality{bars,stale,age_ms,state},
positive_factors[], negative_factors[], blocked_factors[], unknown_factors[],
contradictions[], source_refs[], chart_evidence, state, provenance, anchor_ts_ms
```
`state` ∈ `SCANNING|ANALYZING|CANDIDATE|RISK_CHECK|READY|REJECTED|COOLDOWN|EXPIRED`.

**ChartEvidence** — `annotations[]` each with
`annotation_id, kind, label, price, produced_by{type,id}, source_refs[],
detector_version, evidence_kind`, plus `rules[]`, `assumptions[]`,
`lineage_complete`.

**Strategy** — `strategy_id, canonical_name, family, aliases[], source_status,
empirical_status, runtime_status, runtime_ceiling, why[], unknown_critical[],
has_executable_spec, setup_ids[], source_refs[]`.

**Rule/feature provenance** — rule: `rule_id, kind, description, source_text,
source_refs[], source_status, empirical_status, feature_dependencies[],
predicates[], executable, unresolved[]`. Feature: `feature_id, value, valid,
data_quality, reason, timeframe, timestamp, inputs[], bars_used,
detector_version, source_refs[]`.

**History metadata** — `earliest_available, latest_available, stored_bar_count,
requested_range, returned_range, completion_state, data_quality, gap_count,
dataset_fingerprint, last_sync_ms, has_more_history, earliest_boundary_reached,
transport_window_applied`.

**Experiment** — `experiment_id, dataset_fingerprint, ttt_source, symbol,
timeframe, from_ts, to_ts, bars, strategy/rule/detector/risk/psych versions,
app_version, build_id, git_commit, costs, params, in_sample, oos, walk_forward,
promotion, empirical_status`.

**Error** — `{ ok:false, error, reason?, hint? }` with
`400` bad input / excluded symbol · `401` bad token · `404` not found ·
`409` conflict or insufficient data · `503` unavailable / fail-closed auth.

## 3. Semantics the UI MUST render honestly

| Concept | Values | UI obligation |
|---|---|---|
| Score | 0–100 | always print `score_semantics`: **"decision score, not a probability"** |
| Source status | `SOURCE_VERIFIED` `SOURCE_INFERRED` `UNKNOWN` `CLAIM` `CONFLICT` | never display INFERRED as verified |
| Empirical status | `UNTESTED`→`BACKTESTED`→`OOS_TESTED`→`WALK_FORWARD`→`ROBUST`/`REJECTED` | independent of source status |
| Runtime status | `DISABLED` `CANDIDATE` `PAPER` `LIVE_ADVISORY_ONLY` | show `why[]` on hover |
| Data quality | `OK` `GAPPED` `INSUFFICIENT` `NO_DATA` `UNAVAILABLE` `NOT_SYNCED` | `NOT_SYNCED` ≠ unsupported |
| Completion | `COMPLETE_TO_TTT_BOUNDARY` `PARTIAL` `GAPPED` `NO_DATA` `UNAVAILABLE` | `GAPPED` ≠ `NO_DATA` |
| Stale | `stale:true`, `age_ms` | mark visibly; a stale opportunity is never actionable |
| Unavailable | `status=unavailable, reason, provider=ttt` | show the exact reason; never blank or zero |

**Permanently UNAVAILABLE:** liquidations, long/short ratio, CVD. **PROXY:** tape
flow (aggressor side unverified). Funding is not modelled in replay.

## 4. Progressive chart loading

1. `GET /api/market/history?symbol=…&tf=…&limit=1000` — newest window.
2. Read `metadata.earliest_available` and `metadata.has_more_history`.
3. On pan-left, request `&to=<oldest_loaded_ts - 1>&limit=1000`.
4. Stop when `earliest_boundary_reached` is true or `count === 0`.
5. Render `gap_report` gaps as real discontinuities — **never interpolate**.

`limit` is a transport window; the backend always retains the full TTT range.

## 5. Hard rules for the frontend

- **Never** compute entry/stop/target/RR/score client-side — render what the API returns.
- **Never** call TTT (or any exchange) directly from the browser.
- **Never** put a credential in `NEXT_PUBLIC_*` or client code.
- **Never** show an execution affordance. AsA is advisory-only; the human executes.
- **Never** hide `UNKNOWN`, `CONFLICT` or `CLAIM` — they are first-class UI states.
- TONUSDT must not appear in any symbol picker (the API already excludes it).

## 6. Reference UI already in the repo

`/brain`, `/brain/strategies`, `/brain/rules`, `/brain/unknowns`,
`/brain/conflicts`, `/brain/risk`, `/brain/psychology`, `/brain/search` are
working reference implementations of these contracts.
