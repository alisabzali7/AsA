> **HISTORICAL AUDIT RECORD** from the remediation run. The commit hash, ZIP
> size and SHA256 below describe THAT run's artifact. For the current package
> and commit see `FINAL_STATUS.md` / `PROJECT_SIZE_REPORT.md`.

# FINAL ACCEPTANCE REPORT

CURRENT COMMIT:            d1b26e9
CURRENT DATE/TIME:         2026-09-10T08:59:35.886266+00:00
TTT MARKET COUNT:          63
TONUSDT EXCLUDED:          YES (8 layers; live 400 on candles/analysis/history)
LEGACY_48_REGRESSION_SET:  test-only fixture, 48 symbols, all still listed on TTT
PRODUCTION UNIVERSE SOURCE: ttt-dynamic (discovery_complete=True)
TIMEFRAMES:                5m,15m,30m,45m,1h,2h,4h,8h,1d (9, all native)
NATIVE 1D:                 YES (resolution "1D", never aggregated on outage)
FULL HISTORY:              YES — 775,081 bars cached, chunked to venue boundary
BRAIN RULES:               503
MACHINE-EXECUTABLE RULES:  31
UNFORMALIZED RULES:        426 (+75 UNKNOWN, 2 CLAIM)
SOURCE-DERIVED STRATEGIES: 0 (none met the evidence bar)
HAND-COMPILED STRATEGIES:  6 (7 setups)
GENERATED CANDIDATES:      55 (all DISABLED)
ENABLED ADVISORY STRATEGIES: 0 (none has passed OOS)
TESTS DISCOVERED:          389
TESTS EXECUTED:            389
PASSED:                    389
FAILED:                    0
SKIPPED:                   0
TYPECHECK:                 PASS
LINT:                      PASS
BUILD:                     PASS
SAFETY:                    PASS (no-execution layered assertion + static scan + transport test)
PACKAGED ZIP SIZE:         2,305,992 bytes (2.2 MB)
ZIP SHA256:                9978012ef52537e4f1589e5a606b2d45e2564836b5b1acca22a3700e54a146f5
P0 OPEN:                   0
P1 OPEN:                   0
P2 OPEN:                   0

## Gate results

| # | Gate | Result |
|---|---|---|
| 1 | clean install | PASS (`npm ci`, ~16 s) |
| 2 | typecheck | PASS |
| 3 | lint | PASS |
| 4 | unit tests | PASS (389/389) |
| 5 | integration tests | PASS (replay + brain fixtures present and executed) |
| 6 | critical regression tests | PASS (49 remediation tests) |
| 7 | no-execution safety | PASS |
| 8 | Brain consistency | PASS |
| 9 | dynamic-universe | PASS (63 live, board/stats/candles/analysis) |
| 10 | historical data | PASS (boundary-complete, progressive UI loading) |
| 11 | production import graph | PASS (harness removed from `src/`) |
| 12 | docs/current-status consistency | PASS (stale scans green) |
| 13 | packaging reproducibility | PASS (deterministic + SHA256) |
| 14 | ZIP ≤ 115 MB | PASS (2.2 MB) |
| 15 | independent re-audit | PASS (adversarial sweep clean) |

## Honest limitations (non-blocking, documented)

1. RAW_1/2/4 remain `TRUNCATED_UPSTREAM` at 350,000 chars — complete originals
   do not exist in this workspace and nothing was reconstructed.
2. **Zero strategies are live.** None has passed the OOS gate. This is the
   governance working, not a defect.
3. All 55 generated candidates are DISABLED — they compose teaching prose, not
   deterministic predicates.
4. Funding is not modelled in replay; genuine venue gaps are reported, not filled.
5. Cloudflare Access / private GitHub are documented, not provisioned (they need
   your account).
6. **Rotate TTT, AI and Telegram credentials before deploying.**
