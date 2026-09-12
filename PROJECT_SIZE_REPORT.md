# AsA — Project Size Report

**Commit:** `c29fc81` · **Generated:** 2026-09-11 10:37 UTC

| Metric | Value |
|---|---|
| **Source** | **6.76 MB** (273 files) |
| `.git` (workspace only) | 12.27 MB |
| **Active workspace** | **19.03 MB** (excludes `node_modules`) |
| Runtime DBs in workspace | **none** — rebuildable |

## Handoff exclusions (enforced by `scripts/package-handoff.mjs`)

`.git/**` · `node_modules/**` · `.next/**` · `.npm/**` · `asa-data/**` ·
`*.db` / `*.db-wal` / `*.db-shm` / `*.sqlite*` · `*.tsbuildinfo` · `*.zip` ·
`coverage/**` · `logs/**` · `cache/**` · `.cache/**` · `.config/**` · `.env*` ·
`uploads/**` · `_verify/**`

Every directory rule is written as both `dir/*` and `dir/**` so nested paths
cannot slip through, and the packager **fails** if any `.git` entry is found.

## Retained large files

| File | Size | Why |
|---|---|---|
| `knowledge/canonical/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json` | 1.27 MB | deterministic ingest/audit input |
| `knowledge/raw/RAW_1..5.txt` | 2.31 MB | **immutable source corpus** |
| `docs/ttt/ttt-api-reference.pdf` | 0.34 MB | vendor API reference |
| `package-lock.json` | 0.28 MB | reproducible installs |
| `tests/fixtures/replay/*.json` | ~1.0 MB | real TTT data for deterministic backtests |
| `docs/archive/AsA_Master_Build_Bible_v1.0.pdf` | 0.14 MB | source-of-requirements artifact |

## Rebuildability

`brain.db` and `history.db` are reproducible from source (verified by deleting
each and rebuilding). Only the `experiments` table needs the extra step
`npm run brain:validate`.
