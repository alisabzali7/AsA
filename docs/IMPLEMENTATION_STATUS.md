> **HISTORICAL DOCUMENT.** This is a point-in-time snapshot from an earlier
> build phase and is retained for provenance only. For current truth see
> `FINAL_STATUS.md` and `MACHINE_READABLE_STATUS.json`.

# Implementation Status (evidence-graded)

| Gate | Status | Evidence |
|---|---|---|
| 48/48 symbols render when TTT supplies data | PASS | board = 48 rows; stats matched 48/54 venue→universe filter; TON excluded (tests) |
| Every market value has TTT provenance | PASS | candles/stats/prices carry endpoint + age; UI shows provenance |
| No prohibited venue market data | PASS | `tests/no-fake-scan.test.ts` |
| Chart loads many real candles | PASS | targets 700/800/900; API returns count+closedCount |
| 4H/1H/15M hierarchy | PASS | MTF object + strip + ALIGNED/PARTIAL/CONFLICT/INSUFFICIENT |
| Live price refresh | PASS | stats sweep ~7s + focus tape ~5s; measured ages |
| Freshness visible | PASS | per-symbol Data age pill everywhere |
| Gaps/insufficient visible | PASS | gap counts; INSUFFICIENT ≠ NO TRADE states |
| Unavailable metrics remain unavailable | PASS | capability registry drives UI |
| Orderbook/trades/funding verified TTT | PASS | live probe + capability states |
| No OI/L/S/CVD claims without verification | PARTIAL→PASS | OI now VERIFIED via stats; L/S/CVD = UNAVAILABLE; tape-side = UNVERIFIED |
| Strategy pluggable | PASS | StrategySpec registry |
| AI pluggable | PASS | router + measured health |
| Local AI configurable | PASS | Ollama seam (health-probed; off by default) |
| VPS without redesign | PASS | single process, env-driven, no local-only deps (see deployment docs) |
| UI redesign via components/tokens | PASS | design tokens + shared components; no domain logic in UI |
| Backtest uses same StrategySpec | PASS | `runBacktest(strat.evaluate)` |
| Risk hard-gated | PASS | engine separate; AI forced-reject on block (enforced in coerce()) |
| No execution path | PASS | source scan + API surface review |
| Telegram truthful | PASS | NOT CONFIGURED/DRY_RUN/delivery states from outbox rows |
| AI truthful | PASS | HEURISTIC MODE labeled; LLM only when reachable |
| Manual journal | PASS | CRUD + R auto-calc |
| News retention correct | PASS | 30d policy + audit runs (tests) |
| DB/outbox survive restart | PASS | durable SQLite tables (`asa.db`) |
| Secrets not exposed | PASS | env-only; masked settings |
| Typed contracts | PASS | typed route payloads + client types |
| No fake numbers in source | PASS | source scan |
| Mobile intentional | PASS | bottom nav, chart-first, collapsible drawers |
| fa/en UI | PASS | key-based i18n + RTL + required footer |
| Docs per subsystem | PASS | docs/ |
| Browser E2E automated | PARTIAL | manual browser checklist + API smoke (playwright not yet wired) |
| Local AI runtime verified | BLOCKED-UPSTREAM | requires user Ollama install (detected honestly) |
| Telegram delivery verified | BLOCKED-UPSTREAM | requires user bot credentials (outbox logic ready) |
| TTT auth reads verified | BLOCKED-UPSTREAM | requires user API key (signer unit-tested) |
