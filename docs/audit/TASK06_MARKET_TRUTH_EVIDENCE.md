# Task 06 — Market Truth Contract Closure: Evidence Record

**Date:** 2026-09-25 · **Branch:** `arena/01a0da10-asa` · **Type:** runtime/evidence record (not a status claim for other branches)

## 1. North-star contract status (baseline finding)

`docs/roadmap/ASA_100_PERCENT_CONTRACT.md` **does not exist in this repository** — verified by:

- working-tree search (`find` — no match);
- full git history search (`git log --all --diff-filter=A` over every commit; the repository has a single root commit `dcba86b` and no roadmap path anywhere in its tree).

Consequences recorded honestly:

- there is **no roadmap denominator or percentage formula** to report against;
- the "Market Truth completion units" for this mission were therefore derived from the mission's locked semantics (TTT exclusivity, no synthetic truth, BLOCKED-when-unavailable, replay≠live, freshness/completeness/empty/boundary rules) cross-checked against `docs/api-contract.md`, `MARKET_DATA_FREEZE.md` and `docs/audit/KNOWN_DEFECTS_RESOLVED.md`;
- **no percentage was invented.** Distance is reported per-unit in the mission report.

## 2. Live TTT status: BLOCKED (environment egress policy)

Evidence (2026-09-25, this sandbox):

```text
node scripts/probe-ttt.mjs  ->  failures=9 endpoints=9, "fetch failed" for every endpoint
fetch https://apiv2.thetruetrade.io -> ECONNRESET (TLS handshake dropped)
getent hosts apiv2.thetruetrade.io  -> resolves (Cloudflare IPv6)
curl https://example.com            -> TLS ECONNRESET (general egress blocked)
curl https://registry.npmjs.org     -> HTTP 200 (allow-listed host)
```

Conclusion: DNS resolves but the sandbox egress allow-list drops non-allow-listed TLS
connections. **Live TTT = BLOCKED.** All live-venue verification claims remain
UNKNOWN; no result in this mission may be read as a live-venue observation.

## 3. Replay labelling

Full-chain runtime verification used `scripts/fixture-venue.mjs` — a local,
TTT-shaped **REPLAY/FIXTURE** server (synthetic deterministic bars, clearly
logged `NOT live TTT`). Its outputs verify AsA's pipeline behaviour only.
Fixture/replay output is never reported as live TTT truth anywhere in this
mission's evidence.

Browser automation (Playwright / Chrome DevTools MCP) is **not available in this
session**, and a direct `playwright install chromium` attempt failed with the
same ECONNRESET egress policy. Frontend verification is therefore limited to
unit-tested selectors, source-scans, prerendered HTML assertions and built-bundle
assertions — no in-browser interaction was performed (recorded as a limitation,
not as a pass).

## 4. Verified failure-path matrix (runtime, this environment)

| Scenario | Expected truth | Observed | Status |
|---|---|---|---|
| TTT unreachable at boot | CONNECTING + measured failures; no LIVE | health `CONNECTING`, reason `no successful stats sweep yet; N consecutive failure(s); last: …` | PASS |
| Discovery down | board 503, empty universe, no legacy fallback | `state: NETWORK_FAILURE`, HTTP 503, `symbols: []` | PASS |
| History before first sync | NOT_SYNCED, never NO_DATA/boundary | `earliest_boundary_reached: false` (unit + route tests) | PASS |
| Venue frozen (fetch OK, source timestamps stale) | health ≠ LIVE | `STALE — sweeps succeeding but all 2 measured venue row timestamp(s) are stale` | PASS |
| Venue down after success | age ladder, no upgrade | LIVE → STALE (107 s) → DEGRADED (538 s), `ok:false` | PASS |
| Analysis during venue outage | 502 outage, never empty success | HTTP 502 | PASS |
| History sync during venue outage | stored truth stands; no fresh proof; error recorded | completion/proof retained, `boundary_proven_this_attempt:false`, `last_error` set, success clock untouched | PASS |
| Malformed venue payload | INVALID_RESPONSE, never no_data/boundary | discovery `INVALID_RESPONSE`; sync records `malformed JSON response…` | PASS |
| Restart during outage | persisted truth readable (degraded marker); unknown symbol 503; TON 400 | `discovery_degraded: DISCOVERY_UNAVAILABLE`, proof intact; DOGE→503; TON→400 | PASS |
| Recovery after outage | LIVE only with live rows | `LIVE — stats age 1s; 2/2 rows live`, universe READY | PASS |
| Fixture boundary walk | COMPLETE only via explicit no_data | `COMPLETE_TO_TTT_BOUNDARY + boundary_proof=TTT_NO_DATA`, `proven_this_attempt:true` | PASS (fixture replay) |
| Live TTT | any | — | **BLOCKED (egress)** |

## 5. Multi-process cell lease + crash-window proof invalidation (closure round)

Two closure gaps found by the final mission audit and closed in `src/lib/market/history-store.ts`:

### 5a. Cross-process serialization (was: in-process FIFO only)
- The FIFO chain in `syncHistory()` serializes same-cell callers **inside one process only**. Two processes sharing `history.db` could interleave the same READ-MODIFY-WRITE over the sync row (proof clobber / false-proof coverage) — the very defect the in-process chain exists to prevent.
- Fix: TTL lease (`sync_lease` table in the SAME SQLite file) taken around the cell critical section; heartbeat every TTL/3 across the venue walk; `ensureOwned()` re-verifies (via a renew attempt) before EVERY write — a process that stalled past its TTL aborts without writing. Acquisition composes with the FIFO chain (chain first, then lease), so lease contention can only come from another process. Timeout → explicit rejection (`leaseTimeoutMs` seam, default 120 s).
- Verification — `tests/sync-lease.test.ts` (7 tests):
  1. foreign unexpired lease ⇒ no venue walk, no writes, no theft, explicit timeout after `leaseTimeoutMs`;
  2. expired foreign lease ⇒ takeover + prove;
  3. waiter proceeds when holder releases;
  4. lease released on failure (no leak), cell immediately re-syncable;
  5. **real second OS process** (child `node` inserting the lease row, crash-style exit without release) blocks the sync until its TTL expires, then sync proves the boundary;
  6. **real SQLite store, separate connection** (cross-process stand-in) excludes the sync until `DELETE`;
  7. crash-window test (§5b).

### 5b. Crash-window proof invalidation (was: bars-before-row write order)
- A `put` extending the dataset BEYOND the proven extent made the stored proof stale; a crash between that put and the final `putSync` would strand `COMPLETE_TO_TTT_BOUNDARY + TTT_NO_DATA` over an extent the proof never covered.
- Fix: `putGuarded()` persists the **downgrade first** (completion → `PARTIAL`, `boundary_proof → NULL`, proof_ms → 0), then writes bars. A crash lands on truthful-unproven; a later successful sync re-proves from scratch.
- Test 7 pins the exact sequence (downgrade write = putSync #1, final write = putSync #2 throws "simulated crash"): after the crash the bars ARE stored, the row is `PARTIAL + proof NULL`, lease released; recovery sync re-proves `COMPLETE_TO_TTT_BOUNDARY + TTT_NO_DATA` with `boundary_proven_this_attempt: true`.

## 6. Runtime failure-injection matrix (fixture venue, round 2 — all modes new)

`scripts/fixture-venue.mjs` now injects: `http429, wrongct, ok_empty, zerorows, zeroprice, futurets, slow` (+ previous `http500, malformed, emptybody, frozen`) with runtime switching via `GET /__setmode?m=…`. Dev server + fixture share `/tmp/asa-e2e2/history.db`.

| Phase / mode | Probe | Observed | Verdict |
|---|---|---|---|
| baseline `ok` | history sync=full (fresh DB) | 169 bars, `COMPLETE_TO_TTT_BOUNDARY + TTT_NO_DATA`, `earliest_boundary_reached: true` | PASS |
| `http429` | /symbols, /health | symbols `STALE` + `last_error: "TTT 429 rate limit"` (last-good universe kept, error visible); health `CONNECTING — 3 consecutive failure(s); last: TTT 429 rate limit` | PASS |
| `http429` persistent | /candles | 502 after documented retry+backoff (110 s), never a fake empty success | PASS |
| `wrongct` | /health | `ok:false — unexpected content-type 'text/html; charset=utf-8'` (transport rejects the label) | PASS |
| `zerorows` | sync=full | `INVALID_RESPONSE`, `all 673 UDF row(s) rejected (invalid=673)`, proof null, `earliest_boundary_reached false` | PASS |
| `futurets` | sync=full | `INVALID_RESPONSE`, `all 337 row(s) rejected`, proof null | PASS |
| `zeroprice` (UDF+stats) | sync=full | `INVALID_RESPONSE`, `all 169 row(s) rejected`, proof null — zero prices never stored | PASS |
| `ok_empty` | sync=full | `AMBIGUOUS_EMPTY`, proof null, `earliest_boundary_reached false` (zero candles ≠ boundary) | PASS |
| recovery `ok` | /health, /board, re-sync corrupted cell | health `LIVE — stats age 0s; 2/2 rows live`; board 2/2 `LIVE`; ETHUSDT 15m re-proved `COMPLETE_TO_TTT_BOUNDARY + TTT_NO_DATA`, `earliest_boundary_reached true` | PASS |
| `slow` + **SIGKILL mid-sync** | history.db after kill | **lease row survived the crash** (`owner=3165:…`, dead pid, `expires_ms = acquired+30 s`); sync row UNCHANGED (no partial writes; prior proof intact); `last_attempt_ms` not moved by the crashed attempt | PASS |
| restart after crash | sync=full after lease expiry | takeover in 29 ms (expired TTL), re-proven `COMPLETE + TTT_NO_DATA`, lease released (`LEASES AFTER: []`) | PASS |
| planted foreign lease (5 s) | sync=full | **measured wait 5.0446 s** (blocked for the full foreign TTL), then acquired, proved, released | PASS |
| final recovery | /health, /symbols, /board | `LIVE — stats age 2s; 2/2 rows live`; symbols `READY`, `last_error: null`; board 2/2 `LIVE`, universe `READY` | PASS |
| live TTT | any | — | **BLOCKED (egress)** — fixture replay never reported as live |

Notes (honest limits): discovery self-refresh after an outage is the engine's scheduled 10-minute tick (or a process restart, which re-runs boot discovery) — observed STALE-until-tick with the error still visible; the >10-minute `UNAVAILABLE` health rung was unit-tested, not waited out at runtime (unchanged from §4).
