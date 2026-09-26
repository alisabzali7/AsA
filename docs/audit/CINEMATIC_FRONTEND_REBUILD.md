# AsA — Cinematic Intelligence Terminal: Frontend Rebuild (evidence record)

Branch: `arena/01a0da3f-asa` · Date: 2026-09-26 · Companion to `TEAM04_FRONTEND_TRUTH_RECOVERY.md` (previous pass, whose truth layer is fully preserved).

## A. Source archaeology — honest finding

The master prompt's supplied archive (`فرانت اند asa همه با هم.zip`) and the referenced "Cloud" / "Qwen 8.3"
candidate implementations **do not exist in this workspace**. Evidence: recursive search of `/home/user`,
`/tmp`, `/mnt`, `/data` for any `*.zip` → zero results. `docs/archive/` contains only the read-first PDF,
`PACKAGE_MANIFEST.txt`, `SUPERSEDED_PROMPTS.txt`, `00_READ_FIRST.md` — no frontend code.
Per the task's own rule ("inspect first; if absent, record and do not guess"), **no candidate was merged,
copied, or imitated**. The REBUILD_DECISION is therefore based solely on the in-repo audit (see previous
pass document for that audit's findings).

## B. Rebuild decision: EVOLVE-PARTIAL, not greenfield

Frozen (untouched contracts, verified unchanged at runtime):
- `src/components/resource-state.ts` + hooks polling/mutation layer (the UNAVAILABLE≠EMPTY≠ERROR machine)
- every `/api/*` route, domain truth in `src/lib/**`, the ai-clone deterministic/LLM separation
- per-page TruthState semantics (LOADING/UNAVAILABLE/OFFLINE/ERROR/EMPTY)

Rebuilt (design + interaction layer):
- `src/app/globals.css` — complete design-token system: obsidian surface stack, brass accent family,
  semantic state colors, four motion tiers (MICRO 130 / SHORT 220 / MED 380 / LONG 720 ms), z-ladder,
  density variables, reduced-motion (OS **and** product setting), direction-aware drawer keyframes,
  CSS-only ambient grid (no raster assets).
- `src/components/icons.tsx` — original 24px stroke icon family (29 icons), one language.
- `src/components/chrome.tsx` — persistent shell: desktop collapsible rail (grouped IA: Intelligence /
  Decision / Knowledge / Operations) + slim status topbar (health dot, RTT, palette, density, language);
  mobile bottom nav (5 routes) + More sheet with safe-area handling; route transition = `<main key>` only,
  shell never remounts; connection-axis banner logic preserved verbatim from the truth pass.
- `src/components/nav.tsx` — one nav table (groups + icons + recents), consumed by rail, bottom bar,
  More sheet, palette.
- `src/components/ui.tsx` — primitives: Panel, Metric, Stat, StatusBadge (icon+word+color, `StatusChip`
  alias), ProvenanceBadge, FreshnessIndicator, Disclosure, Skeletons, Tabs, SegmentedControl, Timeline,
  EvidenceBlock, RetryButton, Empty.
- `src/components/overlay.tsx` — ONE focus-trap/scroll-lock discipline behind Dialog/Sheet/More (Escape,
  Tab cycle, focus restore).
- `src/components/toast.tsx` — notification center driven only by real events (saves, backtest results,
  mutation refusals with retry actions); errors outlive confirmations (9s/4.2s).
- `src/components/selection.tsx` — cross-page selection (symbol/tf/returnTo) + device prefs
  (density/motion/rail) on `useSyncExternalStore`; hydration-safe, pre-paint boot script applies them.
- `src/components/palette.tsx` — first-class ⌘K: grouped (Recent/Pages/Symbols/Actions), scorer,
  `!group` filters, real actions (language, density, motion, refresh bus, terminal-open from selection),
  honest empty-universe statement, combobox ARIA; open via `asa:palette` bus event.
- `src/components/market-board.tsx` — living-data flash fires **only** on real snapshot diffs (direction
  comes from the diff, not from change24h); windowed rows >60 (disclosed "windowed rows n–m"); selection
  write-through; token colors; em-dash for nulls preserved.
- Pages: Home rebuilt as command center (hero band with truthful verdict, KPI stagger, event-bus Timeline,
  continue-card, architecture chain); Chart page → "evidence canvas" wording + **no remount on symbol
  navigation** (old `key={urlSymbol}` removed; chart-view derives symbol/tf from the selection store —
  no mirror state); Opportunities/Signals/Psychology/AI/AI-Clone/System/Settings/Backtest got the
  shared PageHead, staggered `rise` entrances, Disclosure/EvidenceBlock composition, toasts on real
  mutation results.
- Fonts: self-hosted via Fontsource — Inter Variable + JetBrains Mono Variable + **Vazirmatn (Arabic
  subsets, unicode-range split)**; `html[lang="fa"]` switches to Vazirmatn and drops uppercase tracking.
  All offline-capable (PWA), no CDN.

## C. Anti-fabrication & governance (now test-locked)

`tests/cinematic-governance.test.ts` (14 tests) enforces: keyframes/easings only in the design layer; no
page re-defines shell primitives; logical properties only (physical `pl-/pr-/ml-/mr-/text-left|right`
banned in pages/chart/board — the sweep also fixed 7 real files); Home LIVE verdict gated by re-derived
sweep age; `—` for nulls, no `+0.00`; flash only from real diffs; no placebo copy; windowing disclosed;
single `key={path}` remount point; safe-area bottom bar; reduced-motion double wiring.

## D. Verification actually run (server: prod build of this tree, port 3000)

- typecheck PASS · lint PASS · **961/961 tests (52 files)** including
  `runtime-dom.test.ts` (real MarketBoard against the live server: UNAVAILABLE + verbatim NETWORK_FAILURE,
  no fake rows/zeros, retry affordance) and NEW `runtime-palette.test.ts` (real palette dialog in jsdom:
  opens via bus event, combobox + focus, **empty universe disclosed verbatim from the live endpoint**,
  query→Enter performs a real router push and records recents).
- Build ✓ (23 pages; the 1 Turbopack trace warning is pre-existing server-side fs tracing, not frontend).
- Route sweep: all 21 app routes 200; SSR HTML contains rail/bottom-nav/skip-link/page-enter/⌘K markers.
- Truth matrix unchanged: board 503 NETWORK_FAILURE · candles/psychology 503 (universe NETWORK_FAILURE) ·
  symbols 200 count:0 state NETWORK_FAILURE · opportunities/signals 200 true-empty · health 200
  market:CONNECTING "first stats sweep pending" · ai-clone 401 without token / 200 deterministic with token.
- PWA: manifest 200 `application/manifest+json`, sw `no-cache`, theme/background #06070a.
- Built CSS contains 7 @font-face, motion tokens, `prefers-reduced-motion`, RTL drawer rules.

## E. Known limitations (also in the final report)

No browser binary in this sandbox → **REAL BROWSER VERIFICATION BLOCKED**: no Lighthouse numbers, no
visual/animation-frame confirmation, no devtools console/network panel evidence; runtime verification is
jsdom-against-real-server + curl SSR/API level. RTL rendering is verified at CSS/token/source level and in
code review, not in a viewport screenshot. Existing PWA PNG icons retained (no raster toolchain here).
