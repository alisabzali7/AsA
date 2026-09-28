# AsA 100% source-to-runtime closure contract

> **Restoration notice.** The earlier denominator-bearing contract text was not recovered in the inspected repository history. This evidence-backed contract is a new source-to-runtime status contract, not a reconstruction of that missing text; it reports explicit states and does not invent a completion percentage.

**Computed closure status:** `CLOSURE_BLOCKED_BY_SOURCE`

As-of: 2026-09-28. This is a point-in-time evidence contract for the inspected checkout, not a claim that the supplied corpus is complete. “100%” means the current source, implementation, provenance, and validation boundaries are explicitly inventoried; it is not a subjective completion percentage and does not mean every source fact has been formalized or implemented.

## Scope and decision rules

1. The supplied transcript bytes are authoritative. The canonical knowledge pack, extracted records, manifests, summaries, and implementation comments are derivatives and cannot repair or override a source gap.
2. Source completeness is recorded per artifact as `COMPLETE`, `TRUNCATED`, or `UNKNOWN`. `UNKNOWN` is not complete. A parser, storage limit, formalized record, test fixture, or LLM answer cannot establish missing source content.
3. Preserve source order, qualifiers, examples, conflicts, and explicit unknowns. Do not resolve a conflict by choosing the most conservative-looking value or by importing generic trading or psychology knowledge.
4. A formalized or named record is not thereby semantically verified, executable, promotion-eligible, or live-eligible. Executable rules require exact backward provenance and applicable source- and implementation-version-bound semantic validation.
5. Psychology descriptions do not become user-state gates by paraphrase. User traits are never inferred. The only user-state inputs are explicit declarations or specifically identified journal-derived fields.
6. Recovery is atomic and evidence-backed. No subjective percentages, reconstructed continuations, fabricated source semantics, or LLM-authored trading rules are allowed.
7. `CLOSURE_READY` requires zero implementation errors, no unresolved source blockers, and all applicable deterministic checks passing. With the current pinned source states, that outcome is not available.

## Supplied-source inventory

The following identities are SHA-256 and exact byte counts for the files in this checkout. `lines` is the recorded source line count; `chars` is the JavaScript string length used by the source contract. The identities and completeness states are also pinned in `src/lib/strategy/compiled/source-contracts.json` and its lock.

### Raw strategy transcripts

| ID | Repository path | Source version | SHA-256 | Bytes | Lines | Chars | Completeness |
|---|---|---|---|---:|---:|---:|---|
| `1.txt` | `knowledge/raw/RAW_1.txt` | `v1-as-supplied` | `b430f52e191c763e7c8752359ddc21820cbe8f79ea58b212f14ca0107d3a7244` | 617,254 | 2,450 | 349,998 | `TRUNCATED` |
| `2.txt` | `knowledge/raw/RAW_2.txt` | `v1-as-supplied` | `0177294c7f5b14b758efab3cd8a3b39e3ed8444766c6bdba318978a3e872fbb1` | 598,290 | 1,987 | 350,000 | `TRUNCATED` |
| `3.txt` | `knowledge/raw/RAW_3.txt` | `v1-as-supplied` | `bf0ae22b7fdbde3959c5563338058d378f030d5506ca5b15cf92f59a2be06cee` | 424,438 | 1,100 | 253,714 | `UNKNOWN` |
| `4.txt` | `knowledge/raw/RAW_4.txt` | `v1-as-supplied` | `bc050e2aefbb9a0bf0894114d791a7e93dfa01afe263e25ade0b04b1b560db8a` | 600,086 | 2,901 | 350,000 | `TRUNCATED` |
| `5.txt` | `knowledge/raw/RAW_5.txt` | `v1-as-supplied` | `1c73c915fe90d7bd5c49f2b93ceab47b15850b795f53989914fa1f53d208baaf` | 184,218 | 960 | 109,216 | `UNKNOWN` |

### User psychology sources

| ID | Original filename in the manifest | Repository path | Source version | SHA-256 | Bytes | Lines | Chars | Completeness |
|---|---|---|---|---|---:|---:|---:|---|
| `USER-PSY-1` | `my phychology/1.txt` | `knowledge/psychology/USER_PSYCHOLOGY_1.txt` | `user-supplied-v1` | `31e52de9d6f6aa0c2ddd072b3986cbc4bb0fe64365ccc3dba852fbe0816eab25` | 624,394 | 2,423 | 349,991 | `TRUNCATED` |
| `USER-PSY-2` | `my phychology/2.txt` | `knowledge/psychology/USER_PSYCHOLOGY_2.txt` | `user-supplied-v1` | `485fa4f9afb49b43ba5fbe4a9b76fba72b157d1ab7a10c721638d5e18ec41e7a` | 160,655 | 640 | 90,370 | `TRUNCATED` |

No supplied text source is currently classified `COMPLETE`. Psychology manifest flags, source-contract identities, ingestion metadata, and the bytes on disk are checked against one another; a disagreement fails closed rather than upgrading completeness.

### Index and supporting artifacts

| Artifact | Identity | Role / limitation |
|---|---|---|
| `knowledge/canonical/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json` | SHA-256 `eecb67c9e21af7563068255f1316f08bee508fd6941e4771a537e6dd7782a891`; 1,330,269 bytes; 17,890 lines | Version `v1.1`, `INDEX_ONLY`. Its five source identities and extracted counts are navigation/audit metadata, not raw-source authority, proof of a complete denominator, or proof that any record is executable. |
| `knowledge/psychology/USER_PSYCHOLOGY_MANIFEST.json` | SHA-256 `e6baa5790bb54a68f599ec61886d31fda05c0b161d0818bc1a6705a10eb5bbf0`; 7,924 bytes; 234 lines | Source identities, original filenames, completeness flags, sections, and source-only extraction metadata; not a substitute for either source file. |
| `knowledge/psychology/inbox/AsA_user_psychology_integration.patch.txt` | SHA-256 `4142670196d49c7311a049b4fbdd9d37674f4b6e48aff5f3fafe83ebff737d59`; 818,916 bytes; 3,768 lines | Retained implementation patch. Its two added-file bodies were extracted and byte-compared with the current psychology source files; both are exact copies and contain no continuation beyond those files. |
| `docs/psychology/USER_PSYCHOLOGY_SOURCE_PACK.md` | SHA-256 `ea46940f39d0c8ac7ed4b9304cc9d254c4c2ec7cedb209b562dd92750aa80abd`; 5,535 bytes; 90 lines | Human-readable source audit, not raw-source authority. |

### Supplementary PDF references

| Artifact | SHA-256 | Bytes | Pages | Treatment in this contract |
|---|---|---:|---:|---|
| `docs/archive/AsA_Master_Build_Bible_v1.0.pdf` | `1b85dfdf47c17c972e4e1325a560f1b8245d4ff086ec8121e609450541533edc` | 145,226 | 50 | Supplementary product/architecture reference; embedded Unicode maps were decoded for pp. 2 and 48–49. It says the personal strategy is not fully source-defined, records a 4H research family with `CHAMPIONS = 0`, and says to keep that family a research artifact rather than hardcode it live. It names a prior research report, registry/results, and an initial project archive; these passages provide no missing strategy rules or transcript continuation. |
| `docs/ttt/ttt-api-reference.pdf` | `ca64384650d1be2971122e1ca0f0a52a56a89db5c28087f45ea3452b6963b34b` | 361,619 | 20 | Supplementary vendor API reference, catalogued by identity and page count; not used as a strategy source or transcript continuation. |

## Source/history recovery audit

The recovery claim is bounded to the inspected local repository and its visible GitHub repository history:

- Inspected the working tree, local refs/branches, reachable Git object names, stash list, and `git fsck --full --no-reflogs --unreachable --dangling`; no stash, unreachable/dangling object, or original `my stratgist.zip` byte sequence was found in those inspected locations.
- Inspected changed-path inventories for all 24 pull requests, visible GitHub branch-tip trees, and the repository release list (no releases listed). The psychology sources and retained integration patch were added in PR #6. PR #19 restored this contract path as a completion-unit notice; it is not the original denominator-bearing contract. See [PR #6](https://github.com/alisabzali7/AsA/pull/6) and [PR #19](https://github.com/alisabzali7/AsA/pull/19).
- Decoding the embedded Unicode maps in the pinned Master Build Bible verified that page 2 says the personal strategy is not fully encoded as a source-defined `StrategySpec`; pages 48–49 characterize the reported 4H family as a research artifact, not a hardcoded live strategy, and list prior-project artifacts by name. The listed `FINAL_AI_TRADE_STRATEGY_RESEARCH_REPORT.txt`, registry/results, `Final_AI_Trade_v0.1.2_NO_TON.zip`, and `README_FA.md` were not found in the inspected workspace or repository history/branch trees. `docs/archive/SUPERSEDED_PROMPTS.md` separately retains only name, byte count, and shortened hash for `FINAL_AI_TRADE_DEEP_RESEARCH_REPORT.txt`; the similar filename is not evidence that it is the Bible's cited report or that its body is present.
- The retained prompt archive is an identity list, not prompt bodies: `docs/archive/SUPERSEDED_PROMPTS.md` records seven names, byte lengths, and only shortened SHA-256 prefixes. `CLEANUP_MANIFEST.md` records prior removals. Neither reconstructs the removed content.
- `docs/archive/PACKAGE_MANIFEST.txt` describes a prior package containing `RAW_ORIGINAL/` files from the user's `my stratgist.zip`, but the archive bytes and that original directory are not present in the inspected checkout/history.
- No external drives, user uploads, provider accounts, or copies outside this GitHub repository were searched. Therefore this audit does **not** claim global unrecoverability. A future recovered artifact must be preserved byte-for-byte, hashed, identity-checked, and related atomically before any completeness or semantic status changes.

The source contract records the missing strategy-semantic adjudication as `UNKNOWN` and performance evidence as `NOT_PRESENT`. These are evidence states, not invitations to fill gaps with inference.

## Source-to-runtime strategy status

`source-contracts.json` is schema/contract version `1.2.0`; its checked-in lock pins contract bytes to `26acf24e2055290a35addd6cb3cf2da9d1b2b83802e7ac97da9546dc65ef94a8`. The source-contract validator identity is `src/lib/strategy/compiled/source-contract.ts`, SHA-256 `9b59de10a32b62f73b4ab9ad5e8a5e4ee4aa3151b81d33ebddd7ad89127c997b`. Source, validator, implementation, setup, direction, timeframe, and strategy/rule-version identities are checked against runtime; identity/reference existence alone is not semantic parity proof.

| Contract / source record | Compiled binding(s) | Current evidence-backed gaps |
|---|---|---|
| `STR-RAW-2-581` — PRZ Bounce Strategy | `SET-STR-RAW-2-581`, long, 1d, strategy `1.1.0`, rule `1.0.0` | Qualitative stop replaced by a fixed 0.25 ATR buffer; target selection differs from the described prior highs; the sourced 5–7 reaction range is collapsed to 5; emergency/news exclusion has no source-backed input. |
| `STR-RAW-2-803` — پرایس اکشن سطوح نامرئی | `SET-STR-RAW-2-803`, short, 1h, strategy `1.1.0`, rule `1.0.0` | Long entry remains explicitly `UNKNOWN`; inverse-side rationale is inferred. Touch range 2–3 is collapsed to 2; stop-zone, TP2, decisive-break semantics, and zoom/context filter do not match or are not wired as source-backed deterministic behavior. |
| `STR-RAW-2-926` — استراتژی ۴-خطی (برگشت از نواحی PRZ) | `SET-STR-RAW-2-926`, short, 1h, strategy `1.1.0`, rule `1.0.0` | Long entry is `UNKNOWN`; touch range, zone-based stop, distinct targets, and persistence after support breaks are not represented with source parity. |
| `STR-RAW-2-1258` — دو قله و دو دره بر اساس نواحی PRZ | `SET-STR-RAW-2-1258-long` and `…-short`, long/short, 1h, strategy `1.1.1`, rule `1.0.0` | Source names 4h/1h/15m and higher-timeframe confirmation; compiled variants fix 1h. Fibonacci stop areas, PRZ-specific target provenance, and risk-free/principal extraction management are not implemented as described. |
| `STR-RAW-4-2425` — هارمونیک پایه (AB=CD) | `SET-STR-RAW-4-2425`, short, 1h, strategy `1.1.0`, rule `1.0.0` | Source permits multiple timeframes; implementation fixes 1h. Stop selection differs. Full TP1/TP2/TP3, partial-exit, risk-free, trailing, slope/structure/no-range conditions are not all represented with source parity. |
| `STR-RAW-4-2449` — هارمونیک پایه معکوس | `SET-STR-RAW-4-2449`, long, 1h, strategy `1.1.0`, rule `1.0.0` | Source says timeframe is free and names both directions; only the long 1h variant is registered. The ≤50% shallow-retrace condition is not proven equivalent; stop/target behavior differs. |

All six contracts currently have `contract_status=INCOMPLETE`, `source_completeness=PARTIAL`, `semantic_validation=NOT_PROVEN` with no named semantic-parity tests, `runtime_status=RESEARCH_ONLY`, `empirical_status=UNTESTED`, `promotion_eligible=false`, and `live_eligible=false`. Record-level labels such as `SOURCE_VERIFIED` or `SOURCE_NAMED` indicate provenance classification only; they do not establish executable semantics. No strategy is promoted by this contract.

The runtime consumer boundary is deterministic: the compiled registry feeds the runtime adapter, rule graph, live-advisory path, research scanner, historical backtest, and promotion gate. Live evaluation requires executable/admission/promotion gates; a research evaluation does not confer live eligibility. The historical runner is a research tool, not an alternate source of strategy meaning. No order execution is present in the AI Clone path.

Promotion evidence binds the exact `source_tree_sha256`, its explicit `source_tree_digest_status`, detector/version identities, the exact compiled setup/direction/timeframe/strategy version/rule-ID-and-version set, and the source-contract document hash. Both the recorded and current source-tree identity statuses must be `COMPLETE`; a matching digest marked `PARTIAL`, `UNKNOWN`, or `INVALID` remains `UNKNOWN` and blocks promotion. Older database rows migrate with identity status `UNKNOWN` rather than being backfilled into a passing state.

## Risk, psychology, and AI Clone boundary

### Risk conflicts and runtime policy

The source-derived policy registry preserves distinct statements rather than silently adjudicating them:

- The 1% “normal per-trade” statement in `RAW_5` (and a `RAW_4` statement) conflicts with the 2% per-trade statement in `RAW_1`; they share a conflict group and require explicit policy selection.
- The separate `RAW_4` “must not exceed 2%” position cap is recorded as a ceiling, not silently equated with the `RAW_1` fixed 2% figure.
- `RAW_4` states a 5% daily-loss limit and a 15% period-loss ceiling; these are different dimensions, not interchangeable values.
- The reported ~11% account risk is an observed small-account/full-margin test result, not a maximum. The same source says normal-account total risk should be below 5–6% and explicitly marks the differing contexts as a conflict. The 11% observation is retained as a `CLAIM`, linked to an unresolved conflict group, disabled, and never converted into an account-risk cap. The ambiguous 5–6% range is preserved without choosing one endpoint.
- A 5% tolerance example remains `CLAIM` and disabled as a production policy. `RISK-ASA-CONSERVATIVE-DEFAULT` is explicitly `SOURCE_INFERRED`, has no source references, and is not evidence of what the corpus says.

Policy eligibility now requires a valid source-contract identity, identity-bound exact quote/range references, and `COMPLETE` source material for every cited source file, in addition to explicit operator selection and no unresolved conflict. Current raw sources cited by risk policies are `TRUNCATED` or `UNKNOWN`, so **no current corpus-derived risk policy is selectable for production**. Stale persisted selections resolve as `BLOCKED`; the UI preserves the operator's stored choice but does not treat it as active. Test-only risk fixtures explicitly bypass this production eligibility gate solely to exercise deterministic calculations and retain the real source-completeness status.

### Psychology boundary

The two psychology documents remain source-only, both `TRUNCATED`. The extraction manifest records section ranges and 11 source-only principles, each with references; the principles are descriptive records, not executable rules. `PSY-DAILY-LOSS` cites exact RAW_4 lines 351 and 1313, but RAW_4 is `TRUNCATED`: the policy is therefore `DISABLED`, is absent from active psychology policy IDs, and evaluates to `UNKNOWN` with an explicit completeness reason even if caller-supplied values would otherwise trigger it. Persisted stale `LIVE_ADVISORY_ONLY` rows are downgraded at read time. It cannot activate until all cited source artifacts are `COMPLETE` and applicable validation is bound. Other inferred thresholds remain labeled as engineering assumptions and disabled. No trait or diagnosis is inferred. A user's declared state or identified journal-derived fields may be evaluated only when present; free-text journal notes are not a gate input.

### AI Clone: received, returned, and influence

A provider request (when the selected provider is configured and online) contains exactly two chat messages: the deterministic system prompt and a user message built from the bounded question, deterministic facts, and serialized `ai_context`; transport metadata also supplies the selected model, temperature `0.2`, and `stream=false`. In `auto` mode a failed provider may be followed by the other configured provider; each attempted call uses that same two-message boundary. There is no prior chat-history message. `tests/ai-clone.test.ts` captures the actual mock-provider request and compares each message byte-for-byte with `buildCloneSystemPrompt()` and `buildCloneUserMessage(question, facts, ai_context)`, including general and personal-psychology requests.

The JSON response returns `ok`, the bounded `question`, validated optional `symbol`, `provider_mode`, deterministic `facts`, the same structured `ai_context`, `explanation`, `explanation_authority`, `explanation_validation`, `tags`, `llm_online`, provider/model/status/error/latency metadata under `llm`, and a response timestamp. Provider prose cannot modify `facts`, `ai_context`, policy state, gate results, or runtime state. It can supply candidate explanation text and thereby affect whether `explanation` is non-null, the token/authority findings in `explanation_validation`, and the model-output-related status/tag; transport success independently sets provider metadata. None of those outputs is fed back into policy, strategy, promotion, persistence, live admission, or orders.

**Always sent on an actual provider call:**

- The user's question (trimmed and capped at 2,000 characters) and the deterministic market/board facts derived for the validated optional symbol.
- Release/build identity and source-tree status; source-contract identity; the six compiled source contracts; current runtime setup IDs, direction/timeframe, strategy/rule versions, availability, promotion summary and source references; and the runtime consumer graph.
- Research/live separation and explicit “no order execution” status.
- The selected risk-policy fields and source/conflict references; configured equity/risk/leverage preferences; advisory open-book rows/risk exposure (or `UNKNOWN`); and realized-loss fields or an explicit unavailable reason.
- Market-context psychology for a supplied valid symbol. This is market context, not a user diagnosis.

**Request-scoped psychology:** when the request classifier recognizes a question about the user's own psychology, the provider additionally receives available explicit/journal-derived state fields, the deterministic psychology-gate result, the psychology manifest SHA/source descriptors, and source-only principle paraphrases with source references. If the question is not classified as personal, the context instead contains `NOT_SHARED_FOR_THIS_QUESTION`, no psychology source descriptors or manifest hash, and an empty source-only-principle list. The classifier is request-scoped, not a trait inference.

**Excluded from the structured context:** raw psychology transcript bytes, raw strategy transcript bytes, free-text journal notes, reconstructed historical user psychology, inferred user traits/diagnoses, and provider credentials. Psychology filenames and identity/provenance metadata may be present for a personal-psychology request; their presence is not source-text disclosure. The user's question itself is forwarded, so users should not include information they do not want sent to the selected provider.

The model can influence only the displayed `explanation` field and associated status/tag. A numeric/symbol token check and a small English/Persian trade-instruction, gate-override, guaranteed-outcome, and risk-free phrase quarantine can withhold some outputs. This is **not** semantic validation: accepted prose remains `NON_AUTHORITATIVE` and `NOT_PROVEN`, may still be misleading, and is never an input to runtime strategy, risk, psychology, promotion, live gates, or orders. If no provider is available/selected, the route returns deterministic context without a provider request.

## Closure decision and remaining blockers

The deterministic validator is `scripts/validate-asa-closure.mjs` (version `1.2.0`), invoked with `npm run closure:validate`. It verifies the seven source identities and pinned completeness states; the supplementary PDFs' SHA-256, byte counts, and page counts; canonical-index role and source relationships; psychology manifest ranges; retained-patch/source byte identity; source and implementation references; compiled setup/version bindings; fail-closed eligibility; required sections and source identities in this document; and every file under `knowledge/`. It then runs the focused semantic/regression suites and the required `typecheck`, `lint`, full test suite, and build. `git diff --check` and human diff review are additional required checks.

The validator reports `CLOSURE_BLOCKED_BY_IMPLEMENTATION` for identity, semantic-contract, focused-test, or required-check failures. If implementation validation is clean but pinned source or semantic blockers remain, it reports `CLOSURE_BLOCKED_BY_SOURCE`. It reports `CLOSURE_READY` only if both classes of blocker are absent. It never changes a source completeness or eligibility state to make the result pass.

**Source blockers that remain regardless of passing implementation checks:** `RAW_1`, `RAW_2`, and `RAW_4` are `TRUNCATED`; `RAW_3` and `RAW_5` are `UNKNOWN`; both psychology sources are `TRUNCATED`; missing continuation and strategy-semantic adjudication remain `UNKNOWN`; all six compiled contracts are incomplete and semantically unproven; and source-faithful, version-bound performance/promotion evidence is `NOT_PRESENT`. Recovery beyond the inspected local/GitHub repository has not been searched. These states prevent `CLOSURE_READY` without any implication that the implementation checks have failed.

No source-semantic promotion, deployment, or release is authorized by this contract. During this audit, the fixed branch `arena/01a0da21-asa` incorporated `origin/main` at commit `7d676fad6f219a9fec93edb8b701b58fdaa4bf22` by a non-rewriting merge; local history was not rebased or rewritten. This integration does not resolve any source blocker or authorize production eligibility.
