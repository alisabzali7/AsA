# AsA — Current Status

**Generated:** 2026-09-30 07:35 UTC
**Commit:** `97c6be1` — equals `git rev-parse HEAD` at generation (stamped at package time)
**Phase:** CLOSURE FIX — timeframe single-source + RSS SSRF + chart import topology + docs reconcile

> Describes the repository **as it is now**. Historical figures live only in
> `MACHINE_READABLE_STATUS.json` → `history[]` or in banner-labelled documents.

## Gates

| Gate | Result |
|---|---|
| `npm ci` | PASS (452 packages) |
| typecheck | PASS |
| lint | PASS |
| tests | **1525 passed · 0 failed · 12 skipped** (83 suites passed, 4 skipped / 87 total) |
| build | PASS (32 routes) |

## Market

| Fact | Value |
|---|---|
| Universe source | **ttt-dynamic** — discovered from TTT at runtime |
| Market count | **63** |
| TONUSDT present | False |
| Legacy 48 | test-only `LEGACY_48_REGRESSION_SET` |

## Handoff integrity

| Check | Value |
|---|---|
| `.git` entries in ZIP | **0** |
| Nested ZIPs | **0** |
| Runtime DBs | **0** |

The packager counts `.git` entries in the produced archive and exits non-zero if
any are present, so this cannot silently regress.

## Workspace

| Component | Size | Status |
|---|---|---|
| **Source** | **6.76 MB** (273 files) | the deliverable |
| `.git` | 12.27 MB | history; excluded from handoff |
| **Active total** | **19.03 MB** | excludes `node_modules` (`npm ci`) |
| `asa-data/` | — | not carried; rebuildable |

## Rebuild

```bash
npm ci
npm run brain:ingest && npm run brain:mine     # rebuilds brain.db
npm run brain:validate                          # regenerates experiments
curl "$HOST/api/market/history?symbol=BTCUSDT&tf=1h&sync=full&limit=1"
```

## Known issues (carried forward — not introduced by this pass)

1. **`experiments` table is not reproduced** by ingest/mine. Run
   `npm run brain:validate` to regenerate OOS/walk-forward evidence.
2. **Brain rule registry and the runtime rule set are separate systems.**
   Executable rules are hand-authored TypeScript in
   `src/lib/strategy/compiled/`, not loaded from `brain.db`.
3. **Zero strategies are live** — none has passed the OOS gate.
4. RAW_1/2/4 remain truncated upstream at 350,000 characters.
5. **Source completeness remains PARTIAL/UNKNOWN/TRUNCATED** — see `docs/roadmap/ASA_100_PERCENT_CONTRACT.md` `CLOSURE_BLOCKED_BY_SOURCE`; no fabricated LIVE/READY.

## Fixes in this closure pass (2026-09-30)

- **Timeframe single-source:** removed duplicate `tfMinutesFor` map in `src/lib/market/store.ts` (now delegates to `getTimeframe`), removed hardcoded `TFS` array in `src/components/chart-view.tsx` (now `TIMEFRAME_IDS`), derived `PRODUCTION_TIMEFRAMES` from `TIMEFRAME_IDS`.
- **RSS SSRF guard:** `src/lib/fundamental/engine.ts` `validateRssUrl` now blocks non-http/https, private RFC1918/link-local/metadata/`.local` and credentialed URLs, and `poll()`/`state()` fail closed with `redirect:"error"`.
- **Chart import topology:** `tests/team02-import-topology.test.ts` now allows the pure `src/lib/domain/timeframes.ts` constant as the single permitted domain import for the chart.
- **Regression tests:** `tests/timeframe-unification.test.ts` (10 checks) and `tests/rss-ssrf.test.ts` (13 checks) added.
- **Docs reconciled:** `MACHINE_READABLE_STATUS.json` regenerated via `brain:audit` (2026-09-30), `FINAL_STATUS.md` refreshed, README brain fragment count updated.
