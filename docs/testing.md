# Testing Guide

> This file describes the suite **as it is now** (measured 2026-09-30 at
> `97c6be1` on branch `arena/01a0f13f-asa`). Earlier revisions of this guide
> claimed "389 tests, 19 files", which had drifted far from reality; numbers are
> re-measured below rather than carried forward.

## 1. The standard gate (no server, no scenario needed)

```bash
npm ci            # native better-sqlite3 is built from source here
npm run typecheck # tsc --noEmit
npm run lint      # eslint .
npm test          # vitest run
npm run build     # next build
```

Measured on this checkout:

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | **87 files passed / 4 skipped · 1561 tests passed / 13 skipped** (91 files, 1574 tests) |
| `npm run build` | PASS |

The 13 skipped tests are the four **live-server suites** below: they skip when
no server is reachable, and they never fake a pass.

```bash
npm run closure:validate   # source-to-runtime closure contract (long-running)
```

Most suites need no infrastructure: the Brain-backed suites build their data from
`knowledge/raw/` via `npm run brain:ingest && npm run brain:mine`, and the
candle-dependent suites use the committed replay fixtures in
`tests/fixtures/replay/`.

## 2. Cross-process concurrency suite (no server needed)

`tests/cross-process-outbox.test.ts` bundles the REAL `SqliteRepo` with esbuild
and drives it from **separate OS processes** against one database file. It is the
only suite that can prove the claim/lease protocol and the publication
transaction across process boundaries:

- 6 processes racing for one outbox row → exactly one claim
- a stale owner (expired lease) cannot write into a reclaimed row
- interrupted final attempt: complete persisted progress → SENT; incomplete → DEAD
- two processes publishing one opportunity → one signal row, one outbox row, no orphan
- a live lease in another process hides the row from the retry selector
- one attempt per claim; a forged claim identity spends nothing

```bash
npx vitest run tests/cross-process-outbox.test.ts
```

## 3. Live-runtime UI verification (needs a running server)

Four suites render the real client components in jsdom against a **real running
server** with no fetch mocking, so what they assert is what a human would see:

| Suite | Prerequisite |
|---|---|
| `tests/runtime-dom.test.ts` | any running server |
| `tests/runtime-palette.test.ts` | any running server |
| `tests/runtime-home-attention.test.ts` | any running server |
| `tests/runtime-opportunities.test.ts` | **stored opportunity rows** (see §4) |

```bash
ASA_QA_ORIGIN=http://127.0.0.1:3000 npx vitest run \
  tests/runtime-dom.test.ts tests/runtime-palette.test.ts tests/runtime-home-attention.test.ts
```

Prerequisite contract of `runtime-opportunities`:

- no server reachable → **skipped** (never a fake pass);
- server reachable but stores **0** opportunities → **skipped with an explicit
  warning** naming the seeding command — an empty database is not a UI regression;
- server stores rows but not the specific case a contract needs → **fails with
  the exact missing case** (seeded-but-incomplete data can never silently pass).

## 4. LOCAL TEST scenario (synthetic seams, real pipeline/DB/HTTP)

`scripts/prepare-team05-local.mjs` compiles a strictly separate test bundle
(esbuild `onLoad` seams for promotion/psychology/risk-policy/runtime/source
gates) plus a local HTTP Telegram stub. It refuses any destination whose basename
is not `team05-local-evidence` and refuses to reseed an existing database.

```bash
node scripts/prepare-team05-local.mjs /tmp/team05-local-evidence seed    # publish + partial delivery
ASA_DB_PATH=/tmp/team05-local-evidence/asa.db \
ASA_HISTORY_DB_PATH=/tmp/team05-local-evidence/history.db \
ASA_LOCAL_EVIDENCE=1 PORT=3001 HOSTNAME=0.0.0.0 npm start &              # serve the scenario
ASA_QA_ORIGIN=http://127.0.0.1:3001 npx vitest run tests/runtime-opportunities.test.ts
node scripts/prepare-team05-local.mjs /tmp/team05-local-evidence retry   # restart: text-only retry, no re-sent photo
```

What the scenario exercises end-to-end (measured on this checkout): real
`scanSymbol` → risk gate → portfolio/psychology gates → publication transaction →
outbox claim → chart photo + advisory text through the local HTTP stub → delivery
state persisted → API/UI read-back, including a partial delivery
(`photo_sent=true, text_sent=false → FAILED`) that a later `retry` completes with
`attempts: 2` and **no repeated photo**.

`ASA_LOCAL_EVIDENCE=1` only displays a LOCAL TEST banner in the UI. It is not an
admission bypass and it generates no fixtures.

## 5. External browser QA (OPTIONAL, currently BLOCKED in this sandbox)

`scripts/verify-team05-ui.mjs`, `verify-team05-closure.mjs` and
`verify-team05-restart.mjs` are Playwright-driven and are **not** application
dependencies. They need an external Playwright install and a Chromium binary:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE=/path/to/chrome \
ASA_QA_URL=http://127.0.0.1:3000 ASA_QA_LOCAL_URL=http://127.0.0.1:3001 \
node scripts/verify-team05-closure.mjs
```

In the current sandbox no Chromium binary exists, so screenshot-level evidence is
**not** produced here; the jsdom suites in §3 are the available substitute and
say so.

## 6. Failure-contract suites worth knowing

- `tests/outbox-failure-taxonomy.test.ts` — why a row is not SENT: content poison
  vs link-terminal vs transport rejection vs budget exhaustion (`error_kind`), and
  the rule that a delivered row carries no failure classification at all.
- `tests/snapshot-identity-contradiction.test.ts` — the two stored copies of the
  decision identity must agree; a contradiction is reported and the chart route
  refuses to render it.
- `tests/telegram-claim-lease.test.ts`, `tests/telegram-partial-send.test.ts` —
  in-process claim/lease and partial-delivery semantics.
- `tests/live-timeframe-coverage.test.ts` — pre-transport classification
  (deterministic poison vs transient infrastructure failure).
