> **HISTORICAL DOCUMENT.** Stage-0 baseline captured at the start of the Brain
> ingestion phase. Figures (68 tests, 48/48 market board) describe that moment.
> Current truth: `FINAL_STATUS.md` / `MACHINE_READABLE_STATUS.json`.

# Stage 0 — Inventory & Safety Baseline (2026-09-09)

## Repo baseline
- head `8701cc7`; Next.js 16.2.6; SQLite repo seam (`src/db/repo.ts` + `sqlite.ts`).
- Gates before this run: typecheck clean, lint clean, 68/68 tests, build passes, `/api/system/status` market LIVE 48/48.
- Execution safety verified: `src/lib/ttt/http.ts` refuses any non-GET/HEAD method at the transport; no order/position/transfer path exists.

## Corpus inventory (immutable source)
| file | lines | unicode chars | bytes | sha256 matches pack |
|---|---|---|---|---|
| RAW_1.txt | 2450 | 349,998 | 617,254 | yes (pack `1.txt`) |
| RAW_2.txt | 1987 | 350,000 | 598,290 | yes (pack `2.txt`) |
| RAW_3.txt | 1100 | 253,714 | 424,438 | yes (pack `3.txt`) |
| RAW_4.txt | 2901 | 350,000 | 600,086 | yes (pack `4.txt`) |
| RAW_5.txt | 960  | 109,216 | 184,218 | yes (pack `5.txt`) |

All five sha256 digests match `ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json.source_files`, proving the
canonical pack is a derivative of exactly these bytes. The pack is therefore usable to accelerate
implementation (authority order #2) without re-deriving everything from scratch.

## [FINDING-1] Upstream truncation of RAW_1/2/4 — CANNOT be repaired from this package
RAW_1, RAW_2 and RAW_4 each stop at **exactly 350,000 unicode characters, mid-sentence**:
- RAW_1 tail: `...فرض این‌که` (sentence cut)
- RAW_2 tail: `...در تایم‌فریم یک دق` (word cut)
- RAW_4 tail: `...در یک روند صعودی (برای گ` (word cut)

RAW_3 (253,714) and RAW_5 (109,216) are below the cap and appear complete.

This is a property of the supplied source material, not of ingestion. The 350,000-char cap was
applied before these files reached us. Consequences, recorded honestly rather than papered over:
- Ingestion is complete **with respect to the bytes supplied**. Provenance covers 100% of them.
- Content beyond the cap in files 1/2/4 does not exist in this package and is **not** reconstructed
  from model knowledge (governance rule 4 / D).
- A `CORPUS_TRUNCATION` capability flag is recorded in the brain and surfaced in the audit report so
  no downstream consumer mistakes truncated coverage for full coverage.

## [FINDING-2] Risk percentages genuinely conflict across the corpus
Grep of the raw files shows differing risk figures that must NOT be averaged (governance F):
`RAW_1:286,329,854,876` → 2% per trade · `RAW_4:2718` → 1% (and 5% ceiling) ·
`RAW_4:351,1313,1346` → 5% daily loss cap · `RAW_4:1898,1958` → ~11% account risk ·
`RAW_4:1934,1958` → 15% period cap · `RAW_5:284` → 1% normal per trade.
These become separate CANDIDATE risk policies in a conflict group; production policy stays
operator-chosen.

## Canonical pack contents (accelerator, authority #2)
`strategy_registry` 55 records (SOURCE_NAMED 39 / SOURCE_VERIFIED 14 / SOURCE_INFERRED 2; all
`UNTESTED`; 39 `DISABLED_UNTIL_VALIDATED`, 16 process-layer), `rule_registry` 503,
`uncertainty_registry` UNKNOWN 750 / CONFLICT 86 / CLAIM 314 / META_COMMENTARY 23,
`section_index` 1209.
