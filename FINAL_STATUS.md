# AsA — Current Status

**Generated:** 2026-09-11 10:37 UTC
**Commit:** `c29fc81` — equals `git rev-parse HEAD`
**Phase:** FINAL RELEASE FIX (release hygiene only; no architecture change)

> Describes the repository **as it is now**. Historical figures live only in
> `MACHINE_READABLE_STATUS.json` → `history[]` or in banner-labelled documents.

## Gates

| Gate | Result |
|---|---|
| `npm ci` | PASS (452 packages, 13 s) |
| typecheck | PASS |
| lint | PASS |
| tests | **389/389** passed · 0 failed · 0 skipped |
| build | PASS |

## Market

| Fact | Value |
|---|---|
| Universe source | **ttt-dynamic** — discovered from TTT at runtime |
| Market count | **63** |
| TONUSDT present | False |
| Legacy 48 | test-only `LEGACY_48_REGRESSION_SET` |

## Handoff integrity

| Check | Value |
|---|---|
| `.git` entries in ZIP | **0** |
| Nested ZIPs | **0** |
| Runtime DBs | **0** |

The packager counts `.git` entries in the produced archive and exits non-zero if
any are present, so this cannot silently regress.

## Workspace

| Component | Size | Status |
|---|---|---|
| **Source** | **6.76 MB** (273 files) | the deliverable |
| `.git` | 12.27 MB | history; excluded from handoff |
| **Active total** | **19.03 MB** | excludes `node_modules` (`npm ci`) |
| `asa-data/` | — | not carried; rebuildable |

## Rebuild

```bash
npm ci
npm run brain:ingest && npm run brain:mine     # rebuilds brain.db
npm run brain:validate                          # regenerates experiments
curl "$HOST/api/market/history?symbol=BTCUSDT&tf=1h&sync=full&limit=1"
```

## Known issues (carried forward — not introduced by this pass)

1. **`experiments` table is not reproduced** by ingest/mine. Run
   `npm run brain:validate` to regenerate OOS/walk-forward evidence.
2. **Brain rule registry and the runtime rule set are separate systems.**
   Executable rules are hand-authored TypeScript in
   `src/lib/strategy/compiled/`, not loaded from `brain.db`.
3. **Zero strategies are live** — none has passed the OOS gate.
4. RAW_1/2/4 remain truncated upstream at 350,000 characters.
