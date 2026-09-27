# ASA 100-Percent Contract — Restored Completion-Unit Form

> **Restoration notice.** The original `docs/roadmap/ASA_100_PERCENT_CONTRACT.md` is
> absent from this repository. Its absence was verified exhaustively on 2026-09-26:
> worktree search, every git ref (`main`, `origin/main`, the session branch),
> `git stash list`, `git fsck --lost-found` dangling objects, and archive/manifest
> locations all failed to produce the file, and no commit in this history ever
> contained it. This restoration therefore does **not** reproduce the original
> text (it cannot be recovered) and does **not** invent percentages: the original
> denominator is lost with it. Per the closure mission, completion is reported
> here in **completion units + states** instead. Any percentage this contract
> could print today would be fabrication, which the contract itself forbids.

## 1. Measurement model

- A **completion unit** is a verifiable slice of the North-Star chain
  (TTT → transport → normalization → freshness → history → boundary →
  persistence/replay → Market Engine → MTF → API → frontend → user-visible truth).
- A unit's **state** is one of:
  - `EVIDENCED_DONE` — implemented AND verified locally with named evidence
    (tests, runtime observations) recorded in `docs/audit/TASK06_MARKET_TRUTH_EVIDENCE.md`
    or the test suite;
  - `BLOCKED` — correct behavior cannot be verified in this environment; the
    blocker is environmental (egress policy), not an open defect;
  - `STALE_CLAIM` — an artifact claims a status that cannot be tied to this
    repository's history;
  - `OPEN` — known gap without a verified fix;
  - `RESTORED` — a contract artifact that had to be rebuilt from evidence.
- **No numeric percent is emitted anywhere in this contract** (rule §0 above).

## 2. Completion units (state, evidence)

| # | Unit | State | Evidence |
|---|------|-------|----------|
| U1 | TTT transport & admission (GET/HEAD, allow-list, no redirects, 429-once, 5xx-no-retry, empty-body rejection) | `EVIDENCED_DONE` (live-venue run `BLOCKED` by egress) | `tests/ttt-admission*`, `tests/scheduler-guard*`; runtime: `wrongct`/`http429`/`http500` matrix rows |
| U2 | UDF normalization (strict numerics, drop invalid/future/misaligned, last-dup-wins, all-rejected throws) | `EVIDENCED_DONE` | `tests/udf-normalize*`; runtime: `zerorows`/`futurets`/`zeroprice`/`ok_empty` rows (all rejected, never proven) |
| U3 | Freshness (single `tfBarMs`, staleness = 2 bars, forming bar excluded, stats source-age > 10 min ⇒ STALE) | `EVIDENCED_DONE` | `tests/market-truth-pipeline*`; runtime: frozen-source ladder |
| U4 | History chunk walk + 8-value `CompletionState` enum | `EVIDENCED_DONE` | `src/lib/market/history.ts`; `tests/history-boundary.test.ts` |
| U5 | Boundary proof (only explicit `s:"no_data"` strictly below held bars; proof separate from completion; retention on failure) | `EVIDENCED_DONE` | `tests/history-boundary.test.ts`, `tests/ttt-closure.test.ts` (29) |
| U6 | Persistence & replay (proof-gated `earliest_boundary_reached`, durable-recovery reads, replay labeling) | `EVIDENCED_DONE` | history/matrix/sync-status routes; evidence doc §4; backtest page `fresh_sync`/`used_stored_data` badges |
| U7 | Multi-process cell safety (per-cell FIFO + SQLite TTL lease + ownership check before every write) | `EVIDENCED_DONE` | `tests/sync-lease.test.ts` 7/7 incl. real second-OS-process test and cross-connection test |
| U8 | Crash-window proof invalidation (downgrade persisted before any extent-extending put) | `EVIDENCED_DONE` | `tests/sync-lease.test.ts` test 7; runtime: SIGKILL-during-sync row inspection |
| U9 | Market Engine source-truth health (endpoint-sourced chip, downgrade-only display) | `EVIDENCED_DONE` | `tests/engine-health-truth.test.ts`, `tests/board-selectors.test.ts` (14); runtime health ladder |
| U10 | MTF analysis (verdict order, honest INSUFFICIENT on short fixtures) | `EVIDENCED_DONE` | `tests/mtf*`, analysis routes |
| U11 | API truth semantics (503 on incomplete discovery, 502 ≠ empty success, proof-gated history flag) | `EVIDENCED_DONE` | route tests + runtime matrix; `docs/api-contract.md` reconciled to actual routes |
| U12 | Frontend truth labeling (health chip, replay badges, chart boundary proof gate, NATIVE/derived badge) | `EVIDENCED_DONE` (browser E2E `BLOCKED` — no browser binary in environment; bundle/prerender/API evidence used) | built chunks, prerendered HTML, runtime API probes |
| U13 | Runtime failure-path matrix (fixture-injected transport/normalization/freshness/crash paths) | `EVIDENCED_DONE` (fixture replay, never live) | `scripts/fixture-venue.mjs` (10 modes + runtime `/__setmode`); evidence doc §6 |
| U14 | Local gates (vitest, tsc, eslint, next build) | `EVIDENCED_DONE` | vitest **50 files / 937 tests / exit 0**; `tsc --noEmit` exit 0; `eslint .` exit 0; `next build` exit 0 (22/22 pages) |
| U15 | Live TTT end-to-end against `apiv2.thetruetrade.io` | `BLOCKED` | probe run 2026-09-25: 9/9 TLS ECONNRESET (egress allow-list); npm-registry control 200 — environment, not a venue outage claim |
| U16 | This contract (denominator-bearing original) | `RESTORED` (as completion-unit form) | this file; absence evidence in the restoration notice |
| U17 | `FINAL_STATUS.md` / `MACHINE_READABLE_STATUS.json` (389/389 @ `c29fc81`) | `STALE_CLAIM` | `c29fc81` is not present in this repository's history; figures not reproducible here; left untouched |
| U18 | Brain corpus (9398 fragments / 104 strategies / 534 rules / 31 machine rules) | `EVIDENCED_DONE` (unchanged this round) | `FINAL_STATUS.md` inventory, consistent with repository content |

## 3. Distance to a future percentage

A percentage can only be reintroduced by restoring a **denominator**: a future
owner must define the unit set (or re-derive it from product requirements),
agree its states as above, and only then compute
`percent = Σ weight(done units) / Σ weight(all units)`. Until that denominator
exists, this contract reports distance exclusively as unit states — exactly as
the mission requires.
