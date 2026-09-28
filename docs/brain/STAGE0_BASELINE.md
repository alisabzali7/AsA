> **HISTORICAL DOCUMENT.** Stage-0 baseline captured at the start of the Brain
> ingestion phase. Figures (68 tests, 48/48 market board) describe that moment.
> The current source-completeness and runtime contract is
> `docs/roadmap/ASA_100_PERCENT_CONTRACT.md`; run `npm run closure:validate` for
> the deterministic closure status.

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
canonical pack identifies these exact supplied bytes. Under the current contract, the pack is a
structured derivative with role `INDEX_ONLY`, not an independent source authority.

## [FINDING-1] Supplied RAW_1/2/4 are explicitly marked TRUNCATED
Their observed sizes are **349,998 / 350,000 / 350,000 unicode characters** respectively, and their
supplied tails stop mid-content:
- RAW_1 tail: `...فرض این‌که` (sentence cut)
- RAW_2 tail: `...در تایم‌فریم یک دق` (word cut)
- RAW_4 tail: `...در یک روند صعودی (برای گ` (word cut)

**Completeness assessment:** RAW_3 and RAW_5 (253,714 and 109,216 chars) are smaller than the
observed RAW_1/2/4 ending sizes, but byte/character count and a clean-looking ending do not prove
that the supplied text includes its original continuation. Their completeness remains `UNKNOWN`;
neither is treated as complete without a source-backed terminal witness.

This describes the bytes supplied to the repo, not proof of where truncation occurred or whether a
continuation survives in another archive/ref. The three flagged files stop near the same observed
350,000-character boundary mid-content; the repository does not establish who or what produced that
boundary. At this baseline:
- Ingestion was complete **with respect to the supplied bytes**. Provenance covered 100% of them.
- Continuation beyond these file endings was not present in the supplied text and was **not**
  reconstructed from model knowledge (governance rule 4 / D). Recovery elsewhere was not yet
  exhaustively assessed.
- A `CORPUS_TRUNCATION` capability flag was recorded in the brain and surfaced in the audit report so
  no downstream consumer mistakes truncated coverage for full coverage.

## [FINDING-2] Risk statements conflict or have distinct dimensions
The source records must remain separate; no percentage is averaged or generalized:
- `RAW_1:286,329,854,876` states 2% per trade; `RAW_4:2718` and `RAW_5:284` state 1% normal per trade. These competing per-trade statements remain unresolved in `CFG-RISK-PCT`.
- `RAW_4:1912` separately gives a 2% per-position ceiling; it is not silently equated with the fixed 2% per-trade statement.
- `RAW_4:351,1313,1346` states a 5% daily-loss limit; `RAW_4:1934,1958` states a distinct 15% period-loss ceiling.
- `RAW_4:202,2718` includes a 5% tolerance example, retained as a disabled `CLAIM`, not mislabeled a prescribed ceiling.
- `RAW_4:1898,1958` reports an approximately 11% small-account/full-margin test observation; it is a disabled `CLAIM`, not an account-risk limit. The source also says normal-account total risk should be below 5–6% and marks the contextual claims as conflicting. The 5–6% interval is preserved without choosing an endpoint or converting it into a cap.

All cited raw material is `TRUNCATED` or `UNKNOWN`, and the competing 1%/2% policies are conflicted. Consequently **no corpus-derived risk policy is production-selectable**. Explicit operator selection does not override incomplete sources or unresolved conflict. See the current eligibility report in `docs/brain/AUDIT.md` and the source-to-runtime contract in `docs/roadmap/ASA_100_PERCENT_CONTRACT.md`.

## Canonical pack contents (structured derivative, INDEX_ONLY)
`strategy_registry` 55 records (SOURCE_NAMED 39 / SOURCE_VERIFIED 14 / SOURCE_INFERRED 2; all
`UNTESTED`; 39 `DISABLED_UNTIL_VALIDATED`, 16 process-layer), `rule_registry` 503,
`uncertainty_registry` UNKNOWN 750 / CONFLICT 86 / CLAIM 314 / META_COMMENTARY 23,
`section_index` 1209.
