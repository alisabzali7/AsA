# AsA final repository recovery audit

**Audit date:** 2026-09-30 UTC
**Baseline:** `97c6be1` (`main`, session branch `arena/01a0f13a-asa`)
**Final verification base:** merged `origin/main` at `8479c80` plus this branch's recovery commit(s)
**Scope:** frontend product completion, truth-state recovery, chart lifecycle, Android/PWA readiness, accessibility primitives, i18n/RTL, performance and release verification.

This is a current audit record. Older audit reports in this repository are retained historical evidence and are not used as current gate results.

## Baseline inventory

- Next.js 16 App Router, React 19, TypeScript strict mode, Lightweight Charts 5.
- The 24 static page routes and the dynamic API route surface build successfully; the source tree contains the shared shell, market board, chart workspace, data-state/provider layer, selection store, bilingual vocabulary, PWA worker and advisory-only server boundary.
- The backend contract is frozen by `BACKEND_FREEZE.md` and `FRONTEND_HANDOFF.md`. This pass does not change strategy, risk, psychology, scoring, market truth or execution semantics.
- Final gates are green after dependencies were made available: typecheck, lint, 1,573 tests passed with 6 skipped across 92 passing test files, and production build. The repository's closure validator remains honestly `CLOSURE_BLOCKED_BY_SOURCE` because the supplied source corpus is incomplete; that is a source limitation, not silently upgraded in the UI.

## Source-to-feedback chain

| Boundary | Current evidence | Result |
|---|---|---|
| Source | TTT-only host allow-list and provider adapters; source-contract/psychology manifests retain hashes, line ranges and completeness | no exchange fallback, no source completion inferred |
| Domain | market/history, opportunity, risk, psychology and strategy modules carry explicit status/reason/provenance | frontend does not recreate strategy/risk/psychology or execution decisions |
| API | route responses preserve `ok`, HTTP status, `state`, `reason`, source, freshness and remediation fields | `503 NETWORK_FAILURE`, empty collections and partial history remain distinguishable |
| Provider → state | `loadResource`, poll sequence guards, abort signals and SSE lifecycle normalization | stale last-good data is retained only with age; late responses cannot paint a new identity |
| State → UI | shared `TruthState`, status badges, board/chart/history error states and shell evidence banner | `UNAVAILABLE`, `ERROR`, `STALE`, `PARTIAL`, `OFFLINE` and `UNKNOWN` are not collapsed into live/zero |
| User action → feedback | selection, palette, chart history retry, overlays, settings and PWA update controls | focus/feedback lifecycle is stabilized; mutations remain advisory and fail closed |

## Route matrix

| Surface | Source → provider/API | Truth/state behavior | Mobile / RTL / a11y review |
|---|---|---|---|
| Home / Command Center | board, health, opportunities, signals, SSE | live/stale/degraded/unavailable retained; attention derived from server payloads | shared shell, bottom nav, logical start/end; curl smoke verified |
| Market | `/api/market/board`, `/api/market/symbols`, stats/orderbook/trades inspector | null metrics remain null; dynamic universe only; windowed rows for large universes | horizontal table scroll and touch-sized actions; board strings now use EN/FA vocabulary |
| Chart / Terminal | candles, history, analysis, MTF, orderbook, trades, opportunities, signals | candle provider status is rendered; history HTTP failure cannot become an exhausted empty boundary | chart-first responsive layout, logical panels, drawing tools and screenshot action remain present; lifecycle fixed, browser interaction unavailable in this environment |
| Opportunities | `/api/opportunities`, chart evidence, AI Clone link | stored empty is distinct from unavailable/error; decision score is not probability | shared cards/drawers and keyboard primitives |
| Signals | `/api/signals`, journal mutations, chart evidence | decision truth is separate from delivery truth; mutations use fail-closed token | shared filters/drawers; backend/API smoke path available |
| Strategies / Brain | `/api/brain/*`, research registry | source completeness, runtime, empirical and promotion blockers are exposed; no strategy is promoted by UI | dense tables/dossiers use shared shell; source contract remains authoritative |
| Psychology | `/api/psychology/summary` and source inventory | unknown/truncated source state is preserved; traits are not inferred | responsive panel layout; no semantic rewrite |
| AI / AI Clone | `/api/ai/status`, `/api/ai/analyze`, `/api/ai-clone` | deterministic facts, provider interpretation, heuristic mode, unavailable and stale response remain distinct | provider state/provenance UI present; no execution path |
| Research / Backtest | strategies, AI calls, authenticated backtest mutation | missing parameters, risk blocks and source/promotions stay explicit | form controls are shared; no fabricated backtest values |
| Fundamental | `/api/fundamental/news` | connector state and stored/empty/error states rendered | responsive list/panels |
| System | health/status/logs/events/config | provider health is not equated with fresh market data; server state/reasons displayed | shared status primitives, keyboard navigable sections |
| Settings | config mutation, local presentation preferences | server config mutations fail closed; browser token is device-local only | language/theme/density/motion/rail persistence; language hydration fixed |
| PWA / shared shell | manifest, `/sw.js`, install/update registration | `/api/*` bypasses service worker; offline fallback contains no market values | safe-area bottom navigation and update/install affordances present |
| Command palette | local routes, selection store, discovered symbols | palette does not invent symbols; empty universe is explicit | keyboard arrows/Enter/Escape and focus trap share overlay primitive |

## Bugs fixed

1. **Hydration mismatch risk for persisted Persian.** `LanguageProvider` read `localStorage` during the first client render while the server rendered English. It now uses `useSyncExternalStore` with an English server snapshot, preserving the pre-paint language bootstrap without changing server markup during hydration. Regression: `frontend-hardening.test.ts` server-render test.
2. **Poll requests survived unmount/symbol changes.** `usePoll` now aborts the active request on replacement/unmount while retaining sequence protection and per-URL data identity. Regression: abort and old-response tests in `frontend-hardening.test.ts`.
3. **SSE retry timers survived unmount.** `useSse` now tracks and clears backoff timers, guards late EventSource callbacks and closes/replaces streams on recovery.
4. **Overlay focus traps reset on every parent render.** `useOverlay` keeps the current close callback in a ref and installs the trap once per mount. Focus restore is only attempted for connected elements; hidden breakpoint branches are excluded by computed visibility.
5. **Chart remounts on drawing/tool/volume changes.** Lightweight Charts now mounts per chart type only; tool and volume changes use imperative options, and canvas redraw callbacks are ref-backed. Viewport and drawings are not lost on normal chart interaction.
6. **Progressive history treated failed pages as empty.** History response normalization now checks HTTP and contract `ok`, preserves provider errors, and exposes retry UI without setting an exhaustion boundary. Regression: `normalizeHistoryPage` tests.
7. **Chart screenshot omitted chart layers.** Export now composes all Lightweight Charts canvases before the user drawing layer.
8. **PWA update notice lived outside the language provider.** `PwaRegistrator` is now inside `LanguageProvider`, so update copy follows the active language. App-shell cache version advanced to `asa-shell-v2`.
9. **Market Board production copy bypassed the vocabulary.** Search, filters, table headings, state/empty text and actions now use the authoritative EN/FA strings.
10. **Next/Turbopack traced the entire repository for dynamic server-only filesystem reads.** Explicit Turbopack ignore annotations removed the build warnings and reduce accidental output tracing without changing runtime source verification.

## Data-state contract

The frontend retains the repository's normalized provider axis:

`LOADING` / `OK` / `UNAVAILABLE` / `OFFLINE` / `ERROR`, with feature-derived `EMPTY` only after an authoritative successful response. Last-good payloads are retained only with a decaying age and are not relabeled live. `NULL` values remain unavailable, not zero. API data is never cached by the service worker.

## Runtime/network evidence

With the local dev server bound to `0.0.0.0:3000`:

- All audited page routes returned HTTP 200, including `/`, `/market`, `/chart`, `/opportunities`, `/signals`, `/ai`, `/ai-clone`, `/research`, `/backtest`, `/fundamental`, `/system`, `/settings` and `/brain`.
- `/api/system/health` returned `200` with `market: CONNECTING` while the first sweep was pending.
- `/api/market/board`, `/api/market/catalog` and `/api/market/stats?symbol=BTCUSDT` returned HTTP 503 with `state: NETWORK_FAILURE`, server reason and no rows/values. No fallback venue or fabricated symbol list was observed.
- `/api/market/symbols` returned `discovery_complete: false`, `count: 0`, `state: NETWORK_FAILURE`.
- `/api/opportunities` and `/api/signals` returned successful empty collections; `/api/ai/status` reported deterministic heuristic mode separately from unconfigured Ollama/OpenAI providers. No LLM answer was represented as available.
- `/api/market/history?symbol=BTCUSDT&tf=1h` returned a stored `PARTIAL` payload with `source: ttt`, `earliest_boundary_reached: false`, and no completion proof. This is retained backend data, not a claim of a fresh live TTT success; `/api/system/health` simultaneously reported market `UNAVAILABLE`.
- `manifest.webmanifest` and icon references were present. `sw.js` explicitly bypasses `/api/*`, non-GET, and cross-origin requests.

## Project-script and verification limits

The final project-script evidence was:

- `npm run closure:validate`: exit 0, but reports `CLOSURE_BLOCKED_BY_SOURCE`; six compiled contracts are `INCOMPLETE` and source files remain `TRUNCATED`/`UNKNOWN`.
- `npm run brain:validate`: exit 0 with zero experiments and no promotion; the replay corpus produced no runnable experiments in this environment.
- `npm run brain:audit`: could not run because `./asa-data/brain.db` was absent; it requested `npm run brain:ingest` and was not converted into a pass.
- `npm run probe:caps`: exit 0 with no credentials; the TTT capability request returned transport status 0, and AI/Telegram were not configured. The probe made no mutations.
- `npm run probe`: exit 1 with nine TTT endpoint fetch failures. This is an external network failure, not a provider-success claim.

No Playwright, Chrome DevTools MCP, Chromium, or Puppeteer binary is installed in this environment. Therefore no screenshots or real browser/Android interaction is claimed. Runtime verification used actual local HTTP responses, source inspection, unit/component lifecycle tests and production build output. TTT, external AI, Telegram and PWA install/update cannot be claimed live without those upstream/device capabilities.

## Current quality classification

- **Verified complete:** TypeScript, lint, full test suite, build, API unavailable/empty truth behavior, provider lifecycle regressions, chart history normalization, service-worker API exclusion/source inspection, no-execution source gates.
- **Implemented but browser-unverified:** desktop/mobile layout, Android touch behavior, chart gestures/drawings/screenshot in a real browser, focus trap in a real browser, light/dark visual balance, Persian RTL visual fit, PWA install/update flow.
- **Blocked by environment:** live TTT success/fresh market workflow, external LLM/Telegram verification, actual Android/Chrome/Samsung/Firefox sessions, screenshot matrix and Lighthouse.
- **Genuinely incomplete by contract:** source corpus completeness and promotion of live strategies remain blocked exactly as reported by the closure validator; this pass does not fabricate completion.
