> **HISTORICAL AUDIT RECORD.** Written during a previous remediation run and
> retained as evidence. Any commit hash, count or 48-symbol figure below
> describes THAT run. Current truth: `FINAL_STATUS.md` /
> `MACHINE_READABLE_STATUS.json`.

# Remediation Final

Every P0/P1 item from the independent audit was inspected against the live
repository, fixed, tested, re-audited and reflected in documentation.

## P0
1. **Dynamic TTT universe** — `operational-universe.ts` is now the single
   production symbol source; 7 modules rewired; discovery runs first at boot
   with 10-minute refresh. Live: 63 markets on board/stats/candles/analysis.
2. **Harmonic filter inversion** — predicate returned `ok: spike`, so violent
   EXPANSION *passed*. Now `ok: !spike`; missing data no longer permits a trade.
3. **Instrument metadata** — `precisions` is a string array (was read as an
   object, always null); `min_qty`, `min_notional`, `settlement_asset` and
   `contract_type` are UNAVAILABLE unless TTT states them.
4. **1D fallback** — a bare `catch` converted any outage into synthetic 1D.
   Only an explicit unsupported-resolution signal authorises derivation.
5. **History vs viewport** — `DURABLE_HISTORY` / `COMPUTE_WINDOW` /
   `CHART_VIEWPORT` named explicitly; the chart pages older history to the
   venue boundary.
6. **No-execution** — re-verified after every refactor.

## P1
7. Reference harness removed from `src/` into `tests/fixtures/`.
8. 503 Brain rules honestly classified (`rule_class`, `non_executable_reason`,
   all DISABLED, only 149 genuinely `SOURCE_VERIFIED`).
9. Engineering policy separated from source semantics via `policy/origin.ts`.
10. Status split into `current` + `history[]`.
11. Stale Postgres/Drizzle refs, dead `DATABASE_URL`, and "48-Symbol Universe"
    UI copy (en + fa) removed.
12. Handoff packaging hardened; SHA256 emitted; nested ZIP excluded.

## Verification
`npm ci` → `tsc --noEmit` → `eslint .` → `vitest run` (389/389) → `next build`
→ live runtime checks → adversarial sweep → deterministic package.

See `FINAL_ACCEPTANCE_REPORT.md` for the acceptance matrix.
