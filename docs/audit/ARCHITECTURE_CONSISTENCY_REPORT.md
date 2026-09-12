> **HISTORICAL AUDIT RECORD.** Written during a previous remediation run and
> retained as evidence. Any commit hash, count or 48-symbol figure below
> describes THAT run. Current truth: `FINAL_STATUS.md` /
> `MACHINE_READABLE_STATUS.json`.

# Architecture Consistency Report

## Single production chain (no shadow architecture)

```
TTT (GET/HEAD only, host allow-list)
  -> market/catalog.ts        dynamic discovery, TON excluded at source
  -> operational-universe.ts  THE production symbol list
  -> market/history.ts        chunked to the venue boundary
  -> history-store.ts         durable retention (no delete method)
  -> features/detectors.ts    deterministic detectors
  -> rules/engine + setup     PASS/FAIL/BLOCKED/UNKNOWN
  -> strategy/runtime.ts      Brain-backed, single registry
  -> risk + portfolio + psychology + score
  -> opportunity admission
  -> chart evidence -> Telegram advisory -> HUMAN
```

## Duplicate-definition scan

| Check | Result |
|---|---|
| Duplicate universe definitions | **none** — one operational source; legacy is a test fixture |
| Duplicate strategy registries | **none** — `registry.ts` delegates to `runtime.ts` |
| Duplicate market-truth loaders | **none** — only `market/history.ts` and `ttt/client.ts` build UDF requests |
| Reference harness in production | **none** — moved to `tests/fixtures/` |
| Postgres/Drizzle references | **none** |
| Hardcoded operational symbol lists | **none** in production paths |

## Storage boundaries
`brain.db` (knowledge) · `history.db` (candles) · `asa.db` (runtime state) —
all gitignored and rebuildable; none ships in the handoff.
