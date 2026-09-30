# AsA — Current Status

> **POINT-IN-TIME RECORD.** The measurements below were generated at the commit
> named in the next paragraph and describe THAT revision, not current `HEAD`.
> They are retained as history and must not be read as a statement about the
> present checkout. Current measured state (gates, suites, prerequisites) lives
> in `docs/testing.md`; the closure contract lives in
> `docs/roadmap/ASA_100_PERCENT_CONTRACT.md`.

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

## Fixes in the delivery-truth pass (2026-09-30, second pass — same day)

- **Outbox failure taxonomy (closure §17):** `telegram_outbox.error_kind` (migration
  v5, guarded ALTER) records WHY a row is terminal/retrying —
  `POISON_PAYLOAD | LINK_NOT_DELIVERABLE | TRANSPORT_REJECTED |
  TRANSPORT_BUDGET_EXHAUSTED | INTERRUPTED_AMBIGUOUS | INFRASTRUCTURE |
  NOT_CONFIGURED | DRY_RUN`. An expired/terminal linked advisory is no longer
  mislabelled "poison payload"; SENT clears the classification and legacy rows
  stay NULL rather than being retro-classified.
- **Contradictory decision provenance is now detected, not papered over:** the
  two stored decision-window copies (`chart_evidence.snapshot` and
  `provenance.data.snapshot`) are compared; `snapshot_identity`
  (`AGREED | SINGLE_SOURCE | CONTRADICTION | ABSENT`) is exposed on
  `/api/signals` and `/api/opportunities`, and `/api/charts/[id]` answers
  **409 `contradictory decision provenance`** instead of rendering either copy.
- **Cross-process verification:** `tests/cross-process-outbox.test.ts` drives the
  real SQLite repository from separate OS processes — exclusive claims under
  6-way contention, stale-owner write rejection, interrupted-final-attempt
  recovery (COMPLETE → SENT / INCOMPLETE → DEAD), publication atomicity with no
  orphan outbox rows, per-claim attempt accounting, forged-claim rejection.
- **Runtime QA prerequisite contract:** `tests/runtime-opportunities.test.ts`
  skips with an explicit seeding instruction when the server stores nothing, and
  fails with the exact missing case when rows exist but are incomplete; the
  answering-but-empty store is now asserted as the honest EMPTY state instead of
  being skipped. Measured after this pass: `npm test` = **91 files (87 passed /
  4 skipped), 1574 tests (1561 passed / 13 skipped)** with no server reachable;
  the four runtime suites are green against the seeded LOCAL TEST scenario
  (12 passed / 1 skipped) and the empty-store direction passes 7 / 6 skipped.
- **Measured end-to-end on the rebuilt app:** outbox row 3 (`sig-77ee1c4aba1293c6`)
  reports `DEAD · LINK_NOT_DELIVERABLE · attempts 0`; the tampered provenance copy
  and the zeroed `chart_source.sha256` both answer **409** on JSON and PNG while
  the pristine record stays `VERIFIED`/`AGREED`.
