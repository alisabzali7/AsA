# Package Content Report

| Metric | Value |
|---|---|
| Archive | `asa-source-handoff.zip` |
| **Size** | **2.2 MB** (2,305,992 bytes) |
| Budget | ≤ 115 MB → **PASS** (98% under) |
| Files | 379 |
| **SHA256** | `9978012ef52537e4f1589e5a606b2d45e2564836b5b1acca22a3700e54a146f5` |
| Forbidden entries | **NONE** |

## Excluded (verified absent)
`.git/` · `node_modules/` · `asa-data/*.db` + `-wal`/`-shm` · `.next/` · `.npm/` ·
`*.tsbuildinfo` · `.env*` · nested `*.zip` · transient script artifacts.

## Included (source of truth)
`knowledge/raw/` (the 5-file corpus) · `knowledge/canonical/` · `src/` ·
`tests/` (incl. replay fixtures) · `scripts/` · `docs/` · configs.

## Reproducibility
`npm run handoff` is deterministic and prints size + SHA256, also written to
`asa-source-handoff.zip.sha256`. Runtime databases are rebuildable:
`npm run brain:ingest && npm run brain:mine`, then history syncs on demand.
