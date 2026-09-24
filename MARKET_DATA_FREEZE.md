# AsA — MARKET DATA FREEZE

**Freeze timestamp:** 2026-09-09 · **Tag:** `market-data-freeze-v1`
**App version:** `asa@6.0.0` · **Commit:** `f3c1727` · **Build id:** `asa@6.0.0+f3c1727`
**Verified live against** `https://apiv2.thetruetrade.io` on 2026-09-09.

> Historical freeze note: exact market counts, cached-bar totals and test counts in this file are the 2026-09-09 freeze evidence, not a live status claim for the current branch. Current runtime status is exposed by `/api/market/symbols`, `/api/market/sync-status` and `/api/system/status`.

---

## 1. Market discovery architecture

The fixed 48-symbol list is **no longer the universe**. The production catalog is
discovered at runtime from TTT `/futures/markets`:

```
TTT /futures/markets
  -> normalizeMarket()        exclusion applied HERE, at the discovery layer
    -> MarketRecord           symbol, assets, contract type, status, constraints
      -> CatalogSnapshot      cached with a 10-minute TTL
        -> registerDiscoveredSymbols()   feeds the synchronous guard
```

`src/lib/market/catalog.ts` · endpoint `GET /api/market/catalog`

**A newly listed TTT contract appears with no code change.** Verified: the 15
contracts added since the original 48 (`XAUUSDT`, `NVDAUSDT`, `TSLAUSDT`,
`COPPERUSDT`, `GRAMUSDT`, `MSTRUSDT`, `SPCXUSDT`, `KAITOUSDT`, `PUMPUSDT`,
`BMTUSDT`, `BTWUSDT`, `BZUSDT`, `CLUSDT`, `TUTUSDT`, `XAGUSDT`) are all served
automatically.

**Exact current market count: 63 discovered · 63 ASA-eligible · 0 excluded present.**

## 2. Dynamic universe semantics

| Tier | Meaning |
|---|---|
| `TTT_DISCOVERED` | present in the TTT market list |
| `TTT_SUPPORTED` | TTT reports the contract active |
| `ASA_MARKET_ELIGIBLE` | active, USDT-quoted, not excluded |
| `ASA_FEATURE_ELIGIBLE` | enough history/precision for a given feature |
| `ASA_STRATEGY_ELIGIBLE` | a compiled strategy can actually run on it |

A market is **never hidden** because a feature is missing — the FEATURE is marked
unavailable. `MARKET_CATALOG` (63) is separate from `STRATEGY_SCAN_UNIVERSE`.

## 3. TONUSDT exclusion

Enforced at **eight** layers: discovery normalizer (returns `null`), catalog
filter, synchronous universe guard, `registerDiscoveredSymbols()` (silently
refuses), history API (HTTP 400), catalog API (HTTP 404), scanner, and tests.

A catalog refresh **cannot** reintroduce it — proven by
`"CANNOT be reintroduced by a market-discovery refresh"`. TONUSDT is not
currently listed by TTT; the exclusion holds regardless.

## 4. Timeframe mapping (all native, verified)

| TF | TTT resolution | verified |
|---|---|---|
| 5m | `5` | ✓ | 15m | `15` | ✓ | 30m | `30` | ✓ |
| 45m | `45` | ✓ | 1h | `60` | ✓ | 2h | `120` | ✓ |
| 4h | `240` | ✓ | 8h | `480` | ✓ | **1d** | **`1D`** | ✓ native |

**1D is requested natively — never aggregated from 8H.** No resolution is shared
by two timeframes, so no silent substitution is possible.

## 5. History retrieval architecture

```
fetchFullHistory(symbol, tf)
  -> chunk backwards, TTT_MAX_BARS_PER_REQUEST (5000) per request
    -> merge + dedupe by timestamp + sort ascending
      -> stop ONLY when TTT answers `no_data` (the true boundary)
        -> validate OHLC, detect gaps
          -> persist to history.db
```

`TTT_MAX_BARS_PER_REQUEST = 5000` is the **venue response cap for one request**,
never a retention limit.

**Proof (BTCUSDT):** one request returns 5000 bars; chunked traversal returns
**6,730** at 1h and **80,763** at 5m — all reaching the venue boundary
`2025-12-03T08:00Z`.

## 6. Cache / storage architecture

Separate SQLite file `asa-data/history.db` (`ASA_HISTORY_DB_PATH`) so a runtime
wipe cannot destroy a backfill. Primary key `(symbol, timeframe, t)` makes writes
idempotent. `history_sync` tracks boundaries, completion, gaps, fingerprint and
retrieval version.

**Retention: candles are NEVER deleted because a viewport moved.** The
`HistoryStore` class has no delete/trim/prune/purge method — asserted by test.
The in-memory `candleManager` window persists to disk *before* trimming.

Incremental sync fetches only the tail after the newest stored bar and
short-circuits entirely when no new bar has closed.

## 7. Chart / history API contract

| Endpoint | Purpose |
|---|---|
| `GET /api/market/catalog` | dynamic catalog · `?refresh=1` `?symbol=` `?eligible=1` |
| `GET /api/market/history` | full-range candles · `?symbol= &tf= &from= &to= &limit= &sync=1\|full &gaps=1 &metadata=0` |
| `GET /api/market/matrix` | symbol × timeframe availability matrix |
| `GET /api/market/sync-status` | observability |
| `GET /api/charts/{id}[.svg\|.png]` | opportunity chart · `?bars= &from= &to=` |
| `GET /api/market/candles` | live hot window (transport only) |

Omitting `from`/`to`/`limit` returns **everything stored**. `limit` is a transport
window for progressive loading and is reported as `transport_window_applied`.

**Metadata:** `earliest_available`, `latest_available`, `stored_bar_count`,
`requested_range`, `returned_range`, `completion_state`, `data_quality`,
`gap_count`, `dataset_fingerprint`, `last_sync_ms`, `retrieval_version`,
`has_more_history`, `earliest_boundary_reached`.

**Errors:** 400 bad input / excluded symbol · 404 not in catalog · 503 TTT
unavailable (never a fallback exchange).

## 8. Gap and data-quality semantics

Completion: `COMPLETE_TO_TTT_BOUNDARY` · `PARTIAL` · `GAPPED` · `NO_DATA` ·
`UNAVAILABLE`. Quality: `OK` · `GAPPED` · `INSUFFICIENT` · `NO_DATA` ·
`UNAVAILABLE` · `NOT_SYNCED`.

Completion is **recomputed from current data on every sync** — a backfilled hole
clears `GAPPED` instead of leaving stale metadata (defect found and fixed this
run). `COMPLETE_TO_TTT_BOUNDARY` is only set when TTT actually answers `no_data`;
a `full` sync probes one chunk older than the oldest stored bar to prove it.

**No candle is ever fabricated.** Observed gaps are genuine isolated venue gaps.

## 9. Current state (measured)

- **63** markets · **63** eligible · **0** excluded present
- **72** synced symbol×timeframe cells · **763,197** cached bars
- **48** cells `COMPLETE_TO_TTT_BOUNDARY` · **24** `GAPPED` (real venue gaps)
- **0** failed syncs
- Oldest candle `2025-12-03T08:00Z` · newest `2026-09-09T18:30Z`

Example depths (BTCUSDT): 5m 80,763 · 15m 26,917 · 30m 13,459 · 45m 10,000 ·
1h 6,730 · 2h 3,365 · 4h 1,682 · 8h 841 · 1d 278.
New listing XAUUSDT honestly reports 3 daily bars (listed 2026-09-07).

## 10. Fixed-N audit result

`grep -rnE "candles\.slice\(-[0-9]{3,}\)" src/` → **NONE**.

Removed: `candles.slice(-400)` (chart route), `Math.min(5000, …)` bar cap
(backtest route). Retained and reclassified as transport: the venue chunk size,
the `limit` param on `/api/market/candles`, and the in-memory RAM window (which
now persists before trimming). A permanent test fails if any hardcoded recent-N
candle ceiling reappears.

## 11. Tests

**307 passing**, including 37 market-data tests: discovery, normalization,
TON exclusion at every layer, the 48-symbol regression set, all nine resolutions,
native 1D, dedupe/sort/gap/OHLC validation, 12,000-bar full-range read,
transport windowing, no-delete retention, completion recomputation, boundary
proof, and the static fixed-N audit.

## 12. Invariants unchanged

TTT-only (host allow-list) · no execution capability · no other exchange · no
fabricated history or metrics · strategy semantics untouched · Brain untouched.
