# Test Execution Report

**Command:** `npm ci && npx vitest run`
**Environment:** clean install verified — `npm ci` completes in ~16 s; vitest present.

| Metric | Value |
|---|---|
| Test files | 19 |
| Suites | 113 |
| **Discovered** | **389** |
| **Executed** | **389** |
| **Passed** | **389** |
| Failed | 0 |
| Skipped/pending | 0 |

Discovered == executed == passed. No test is counted as passing without running.

### Conditional suites
Several suites use `describe.runIf(hasReplay)` / `it.runIf(hasBrain)`. Both
fixtures are present in this workspace, so those tests **executed**. In an
environment lacking `tests/fixtures/replay/` or `asa-data/brain.db` they would
be reported as skipped, never as passed.

### Coverage areas
universe (dynamic + legacy regression) · TON exclusion · market metadata ·
1D fallback classification · harmonic filter · history/viewport · Brain
governance · rule classification · strategy lineage · risk · portfolio ·
psychology · score · opportunity admission · backtest · lookahead · fees ·
slippage · position/fill accounting · OOS · walk-forward · promotion ·
reproducibility · chart evidence · Telegram · packaging · no-execution ·
production import graph · stale-doc scan.
