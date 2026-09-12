> **HISTORICAL DOCUMENT.** Point-in-time snapshot from an earlier build phase,
> retained for provenance. Figures such as "48 symbols" describe the universe as
> it was THEN; the production universe is now discovered dynamically from TTT.
> For current truth see `FINAL_STATUS.md` / `MACHINE_READABLE_STATUS.json`.

# AsA — Benchmark / Handoff Report

Date: 2026-09-05 (all runtime evidence collected this date against live TTT public endpoints)
Repo root: `/home/user` (git; head `057ab70`). App version: `6.0.0` (`src/lib/env.ts`).
Evidence labels used throughout: **[S]** source, **[T]** passing test in the 66-test suite, **[F]** fixture under `tests/fixtures/live/` (real TTT captures, 2026-09-05), **[L]** live TTT public-endpoint probe, **[R]** runtime curl/UI measurement against `npm run dev` (Next 16.2.6, Turbopack), **[B]** `next build` production build, **[D]** doc under `docs/`.

---

## 0. How to verify everything in this report

```bash
npm ci            # clean install from lockfile (node >= 20.9)
npm run typecheck # tsc --noEmit  -> clean
npm run lint      # eslint .      -> clean
npm run test      # vitest run    -> 9 files, 66 tests green
npm run build     # next build    -> production build passes
npm run dev       # boot -> http://localhost:3000 (zero env needed: public-only TTT)
npm run probe     # optional live TTT probe (see scripts/probe-ttt.mjs; private routes stay unconfigured)
```

Environment: copy `.env.example` → `.env.local`. Defaults: TTT public base `https://apiv2.thetruetrade.io`, 24 req/min shared budget, SQLite at `./asa-data/asa.db` (gitignored). No API key is required; when `TTT_API_KEY`/`TTT_API_SECRET` are absent the app is restricted to public endpoints by construction and the UI says so ([S] `src/lib/ttt/http.ts`, `src/lib/env.ts`).

---

## 1. Scope statement and greenfield disclosure

The uploaded repository was attached to this workspace with the instruction to improve it. **Disclosure: the attached "AsA repository" contained only specification/status documentation plus an untouched Next.js template — zero application source files, zero tests, zero `.env.example`, despite `docs/IMPLEMENTATION_STATUS.md` claiming 31 passing tests and 9 implemented files (none existed on disk).** Because no application code existed to improve, this session continued a **greenfield implementation of the documented spec** rather than an incremental patch. No explicit approval for the greenfield route was received; the decision was taken because (a) the alternative — leaving the repo as documentation-only — could not satisfy any benchmark criteria, and (b) the bundled docs form a coherent, testable specification of record. All earlier work sessions plus this closing verification window are recorded in git history from `da1159d` (baseline: docs only) forward.

---

## 2. Acceptance thresholds (measured)

| Threshold | Requirement | Measured | Evidence |
|---|---|---|---|
| Repository file count | ≤ 10,000 | **139 tracked files** (168 before de-tracking `.npm` cache) | `git ls-files \| wc -l` |
| Repository size | ≤ 120 MB | **~1.3 MB tracked** (78 MB before de-tracking `.npm` cache; node_modules/.next excluded by .gitignore and sandbox snapshot policy) | `git ls-files -z \| du -ch` |
| Tests green | pass | 66/66 (9 files) | `npm run test` |
| Typecheck | clean | 0 diagnostics | `npm run typecheck` |
| Lint | clean | 0 problems | `npm run lint` |
| Production build | passes | compiled 5.7s + TS 5.8s, 14 routes prerendered | `npm run build` |

---

## 3. Verification gates

- **[B]** `next build` passes; one prerender defect (missing Suspense around `useSearchParams` on `/chart`) was found and fixed this window.
- **[T]** 66 tests / 9 files: `universe-tf`, `ttt-signer`, `udf-normalize`, `risk-engine`, `market-store`, `scheduler-guard`, `retention-news`, `backtest`, `i18n-scan`. All deterministic, hermetic (temp SQLite or stub HTTP servers), no network.
- **[T]** i18n source scans are comment-aware (comments may *name* venues the source guard rejects; code may not) and route-surface checks are segment-exact (read-only `market/orderbook` is not an order-execution route).

---

## 4. Subsystem status (26 sections)

1. **Repository integrity & provenance** — BEFORE: docs-only baseline claiming implemented tests; stale `IMPLEMENTATION_STATUS.md` counts. AFTER: real code + tests; git history documents every step from the docs-only baseline; runtime DB (`asa-data/`) is gitignored; `.npm` cache de-tracked ([S],[B]).
2. **Startup/build commands** — BEFORE: none runnable (template only). AFTER: `npm ci/run dev/test/build/typecheck/lint/probe` all verified; dev boot ~0.4s, first LIVE board snapshot ~1.2s incl. real TTT fetch ([R]).
3. **Config separation & secrets** — env parsed centrally in `src/lib/env.ts`; `.env.example` committed; `.env*` gitignored; client/components never reference secret env names ([S],[T] i18n-scan).
4. **TTT as sole market-data source** — a loud source guard (`ensureTttSource`) is the single boundary; no other venue identifiers exist in production code ([S],[T]); 12 live public endpoints probed and captured as fixtures ([F],[L]).
5. **Universe & timeframes** — exactly 48 canonical symbols, TONUSDT excluded from every tradable surface and named only in exclusionary copy ([S],[T]); 10 timeframes 1m–1d; 1d requests **native resolution `1D`** with a labeled 8h-derived fallback ([S],[T],[R] `/api/market/candles?tf=1d` returns UTC-aligned native days).
6. **UDF normalization integrity** — duplicates (venue repeats the final timestamp in real payloads, [F]) resolve **last-wins** to match the documented contract (implementation was repaired this window to match its own doc); invalid rows, OHLC violations, gaps, and `s:"no_data"` at HTTP 200 handled explicitly ([S],[T],[F]).
7. **Rate scheduler** — token bucket with continuous lazy refill (configurable, default 24/min), 429 circuit pause with budget shrink and 4/min floor, counters on the System surface ([S],[T]). **Defect found and fixed this window:** the bucket never refilled after the initial balance (cold fetches stalled 106–111 s); refill now runs continuously and is frozen during pauses ([R]: cold 8h/1m fetches 0.21–0.25 s after fix).
8. **Transport safety** — GET/HEAD only, unsafe methods rejected before I/O; retries with jitter; 401/403 never retried; 429 bounded backoff; error taxonomy with `kind` ([S],[T] stub-server tests).
9. **Live board & stats** — `/futures/markets/stats` sweep covers 48/48 with one request/cycle; board rows carry price/change/funding/OI/mark/index/age/state/provenance ([S],[R] stats age ~3 s, 48/48 live).
10. **Focus lanes (tape/book/funding)** — trades & orderbook for the focus symbol, spread measured, side semantics explicitly `UNVERIFIED`; funding history every 30 min ([S],[R]).
11. **Candle series manager** — bounded memory, per-TF targets, request coalescing, close detection, per-request depth override (up to 5000 bars) for backtests ([S],[R]).
12. **Fairness** — per-symbol metrics in store/coverage; 48-symbol coverage table with per-TF status rather than conflating live board with historical coverage ([S],[R] `/api/market/coverage` distinguishes LIVE vs PENDING).
13. **Analysis/indicators** — deterministic EMA/RSI/ATR + structure (swings, BOS/CHoCH, FVG, S/R) over real bars; 700-bar 15m analysis served in ~0.8 s ([S],[R]).
14. **MTF** — 4H/1H/15M bundle with ALIGNED/PARTIAL/CONFLICT/INSUFFICIENT verdicts ([S]).
15. **Psychology honesty** — MEASURED/DERIVED/PROXY/UNAVAILABLE-with-reason taxonomy; today funding+OI are context only, bias stays neutral with an explicit reason; liquidation pressure and tape-side semantics are never asserted ([S],[R] `/api/psychology/summary`).
16. **Risk engine** — leverage vetoes, stop-beyond-ESTIMATE-liquidation veto (correctly reachable only under high-tier maintenance-margin inputs; unit tests encode the correct algebra), ESTIMATE labeling, fee assumptions from catalog coefficients ([S],[T]).
17. **AI router** — deterministic `heuristic` provider online by default and labeled "NOT AN LLM"; ollama/openai adapters honest NOT_CONFIGURED; structured verdict contract; AI can never override a BLOCK ([S],[R] `/api/ai/analyze`, `/api/ai/status`).
18. **Pipeline & signals** — opportunity/signal lifecycle with explicit states, risk gate, cooldowns, stale expiry; day-one run reports 0 opportunities honestly (requires accumulated multi-day series) ([S],[R]).
19. **Journal/outbox/Telegram** — journal CRUD via API; Telegram adapter states NOT_CONFIGURED / DRY_RUN / CONFIGURED; outbox drain only when configured ([S]).
20. **Fundamental/news + retention** — connector registry, RSS connector, dedupe keys, 30-day rolling window with audited retention runs; NOT_CONFIGURED-with-reason when `NEWS_RSS_URL` empty ([S],[T],[R]).
21. **Research & backtest** — deterministic engine, explicit same-bar policy, lineage with assumptions + data_range, funding-not-modeled flag; anti-lookahead entry at next open; per-request depth up to 5000 bars; truncation warning when the venue returns less ([S],[T],[R]).
22. **Real-data backtest result (14 d BTCUSDT)** — 2144 real 15m bars fetched; 395 trades, win rate 57.5%, profit factor 1.22, +23.74% gross, max DD 21.1%; every trade labeled with policy caveats; run time ~2.4 s ([R]).
23. **API surface & mutation guards** — 31 route files, all read/advisory (no order/position/withdraw/transfer/account paths); the only POST/PUT surfaces are config, focus preference, journal, ai-analyze, backtest requests ([S],[T] scan). Note: mutation endpoints are open when `ASA_API_TOKEN` is unset (documented default for local; set it to enforce the header).
24. **SSE events** — typed event bus with JSON history (`?limit`) and SSE stream (`?stream=1`) incl. heartbeat; live events observed (`price.updated`, `candles.updated`, `trade.received`) ([S],[R]).
25. **i18n & footer** — en/fa + RTL; byte-exact required footer string in every language table ([S],[T]).
26. **UI pages** — 11 pages all 200 in dev ([R]); chart-centric terminal with 10 TF switch, native-1D flag, structure annotation lines; production prerender fixed ([B]).

---

## 5. Runtime measurements (2026-09-05, dev server, live TTT)

| Measurement | Value |
|---|---|
| Server ready | ~0.4 s |
| First `/api/market/board` (incl. first live TTT fetch + engine boot) | ~1.2 s; later polls ~0.1 s |
| Board freshness | stats age ~3 s (7 s sweep cadence), 48/48 rows LIVE |
| Cold candle fetch after scheduler fix | 0.21–0.25 s (was 106–111 s before the fix) |
| 15m analysis, 700 real bars | ~0.8 s |
| Backtest 14 d / 2144 bars incl. fetch | ~2.4 s |
| SSE events observed in 4 s window | `candles.updated`, `price.updated`, `trade.received` |
| Scheduler | 24/min configured, 0×429 observed in smoke, waiters 0 |
| Production build | compile 5.7 s + typecheck 5.8 s |

---

## 6. Repairs & discrepancies recorded this window

1. **Token-bucket starvation (severe)** — scheduler never refilled after the initial balance; under load every further TTT request stalled (measured 106 s and 111 s cold fetches). Fixed with continuous lazy refill frozen during 429 pauses. Re-measured 0.21–0.25 s.
2. **UDF duplicate handling** — implementation kept the *first* bar of a repeated timestamp while its own docs and tests required *last-wins*; aligned implementation to the documented contract (real venue repeats final timestamps, [F]).
3. **Test fixture arithmetic** — several tests encoded wrong math (leverage is independent of equity in this sizing model; 15m/hour grid alignment; 4h bucket geometry; duplicated-ts count in the native-1D payload). Tests corrected to the true semantics — no assertion weakened.
4. **Test isolation** — `ingestNews` reached the app-wide DB singleton from tests; made injectable, temp-file DB used; stale dev DB removed and gitignored.
5. **Source scans** — were crude word scans (false positives on comments, `orderbook`, legit `risk.maxLeverage` config keys); now comment-aware and segment-exact, still asserting the same invariants.
6. **Backtest reachability** — 700-bar fixed fetch + 200×4h macro warmup made real-data trades impossible by construction; per-request depth to 5000 bars and warmup 64×4h now fit single-window runs; a 395-trade real-data run validates the fill/exit machinery.
7. **React 19 purity lint errors (7)** — setState-in-effect and render-time impure calls fixed across lang/chrome/hooks/market-board/chart; price-flash diffing moved into async poll callbacks.
8. **Production prerender** — `/chart` needed a Suspense boundary for `useSearchParams`.
9. **Repo hygiene** — `.npm` cache was tracked in the baseline (78 MB); removed from index and ignored.
10. **Baseline doc reconciliation** — `IMPLEMENTATION_STATUS.md`/CHANGELOG claims (31 tests, 9 files) predate the real suite; current truth: 66 tests / 9 files / 139 tracked files; CHANGELOG updated with a 6.0 section.

---

## 7. Honest limitations (unchanged by design)

- Advisory only: AsA never places orders; there is no order/position/withdraw/account code path and none is planned.
- Private TTT endpoints are not integrated (no API key configured); public-endpoint-only operation is explicit in the UI and config.
- Backtests do not model funding (flagged in every run); same-bar fills follow an explicit documented policy, not venue matching.
- Day-one opportunity/signal counts are 0 until multi-day series and qualification thresholds accumulate; the engines report that state honestly rather than synthesizing activity.
- Liquidation figures are labeled ESTIMATE (derived from tier-1 maintenance margin), never presented as venue fact; psychology bias stays neutral while inputs are context-only.
- News, Telegram and real-LLM providers are NOT_CONFIGURED by default with explicit reasons.

---

## 8. Artifacts

- Fixtures (real TTT): `tests/fixtures/live/` (16 files incl. README describing each capture).
- Probe script: `scripts/probe-ttt.mjs` (`npm run probe`).
- Spec docs: `docs/` (architecture, api-contract, deployment, strategy-ext, ai-ext, news-connectors, retention, security, IMPLEMENTATION_STATUS.md).
- Runtime DB (gitignored): `asa-data/asa.db` — smoke-run state incl. backtest job records.
