# Team 04 — Frontend Truth Recovery (2026-09-25)

Scope: frontend provider/state architecture, data-state honesty across all
major surfaces, AI Clone UX, accessibility, RTL, command palette / mobile nav,
PWA update behavior, mutation auth UX. Backend was treated as frozen; no API
routes were changed.

## Root causes fixed (verified, not assumed)

1. **Provider layer collapsed truth.** `usePoll` threw on every non-2xx
   response and kept only `"HTTP <status>"`. The backend's structured
   `UNAVAILABLE` verdicts (e.g. `503 { state:"NETWORK_FAILURE", error:… }`)
   were repainted by pages as perpetual "loading…" or bare errors —
   semantically wrong in every surface (Home, Market, Chart, Psychology,
   Signals, Opportunities, Settings, Fundamental, Backtest).
   Fix: `src/components/resource-state.ts` normalizes every load to
   `LOADING / OK / UNAVAILABLE / OFFLINE / ERROR`, carries the server's own
   `state`, message and `hint`/`remediation` verbatim, and never clears the
   last authoritative payload (retained data ages visibly instead of freezing
   as "fresh"). `usePoll` now exposes `status`, `failure`, `stale_age_ms`.
2. **Settings fabricated defaults.** The risk/AI form showed `10000 / 1 / 5 /
   auto` regardless of the stored prefs. Fix: inputs read `edited ?? server
   prefs` — never a guess as truth.
3. **Psychology hardcoded symbols.** A fixed 7-symbol picker offered symbols
   the dynamic universe may not contain. Fix: picker is fed by
   `/api/market/symbols`; when the universe is unavailable the page says so
   instead of requesting invalid symbols.
4. **Chart repaint:** "waiting for real TTT candles…" was shown even after the
   server explicitly answered UNAVAILABLE. Fix: LOADING only while the first
   request is in flight; UNAVAILABLE shows the server reason; a genuine empty
   venue answer is labeled EMPTY/backfill; `freshness STALE` and `UNAVAILABLE`
   from the closed-bar contract are visible as badges.
5. **Mutation UX:** all mutation calls now go through `postJson`, which
   attaches the operator token (Settings → "operator token", localStorage,
   never bundled) so production fail-closed 503/401 denials are actionable
   instead of dead ends; refusals surface verbatim; an unsent question on the
   AI Clone page is recorded as NOT SENT — never a fabricated answer.

## New product surface (each projects an existing endpoint; no invented APIs)

- `/ai` — AI Analysis runner over the real `POST /api/ai/analyze` (the README
  already documented this page; it did not exist). Renders the typed
  `AiResponse` verbatim with provider label (`HEURISTIC MODE · NOT AN LLM`,
  `HEURISTIC FALLBACK · LLM FAILED`, …), score semantics line, evidence,
  contradictions, missing data, closed-bar timestamp. No client-side
  decisions.
- Command palette (⌘K / Ctrl+K; ☰ on small screens): pages from the shared
  `nav.ts`, symbols from the LIVE universe endpoint, language action. Focus
  trap, `aria-modal` dialog, keyboard navigation, RTL-safe; says so when the
  universe is empty. The nav table is shared by header, palette and mobile
  so the three cannot drift.
- AI Clone: LLM state badges are now exhaustive — `LLM · provider` (ok),
  `LLM FAILED — deterministic facts only` (fallback, with error), `no LLM
  provider — deterministic assembly` (disabled); answers carry
  "answered Xs ago — snapshot, not live"; fact lines are visibly typed
  FACT / RULE / UNAVAILABLE (the server's own prefixes).
- PWA: update awareness (a visible, dismissible "shell updated — reload"
  notice on SW takeover) + `Cache-Control: no-cache` on `/sw.js` and
  `/manifest.webmanifest`. The SW still never touches `/api/*`.
- System: risk-policy panel mirrors the persisted prefs that feed the
  server-side gate (inputs only — verdicts stay on the server).

## Accessibility / RTL

- Skip link, `aria-current`, `aria-pressed`, labelled selects/buttons,
  `role=status`/`aria-live` on state banners, table captions + scope,
  Persian footer marked `lang="fa" dir="rtl"`, pre-paint RTL restore script
  (no LTR flash for saved Persian).
- `text-left/right` → `text-start/text-end` throughout (logical properties);
  `me-1/ps` in new code.

## Tests added

- `tests/resource-state.test.ts` (13) — classification contract, using
  REAL captured payloads (board/candles 503, mutation fail-closed 503).
- `tests/provider-state-contract.test.ts` (18) — regression locks: provider
  uses the classifier, never drops structured failures, never clears good
  payload on failure; every data surface consumes `<TruthState>`; no mock
  imports in production components; palette has no hardcoded universe;
  settings has no fabricated defaults.
- `tests/runtime-dom.test.ts` (2, live-server-gated) — renders the real
  MarketBoard client component in jsdom against the RUNNING server; asserts
  the DOM shows UNAVAILABLE + the server's own `NETWORK_FAILURE` token/reason
  and no fabricated rows/zero-percents; auto-skips without a server.
- `tests/pwa-state.test.ts` — parity check strengthened: every EN namespace
  must exist in FA (Persian is first-class, so missing fa namespaces now
  fail the suite).

## Known limitations (documented, not hidden)

- No browser binary in the verification sandbox; visual mobile/touch and
  console/hydration QA are covered by DOM-runtime + server-log evidence only.
- TTT venue unreachable in this sandbox: market surfaces were verified in
  their honest UNAVAILABLE/NETWORK_FAILURE rendering, not with live prices.
- `brain:validate` (OOS experiments) needs TTT history; not re-run here.
