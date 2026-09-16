# Strategy Validation & Promotion Pipeline

    Registry → Executable → Validation → OOS → Governance → Promotion → (Live)

**Non-negotiable:** `executable ≠ validated ≠ promotable ≠ live eligible`.
A compiled strategy is a *candidate*, never a live strategy. Nothing in this
pipeline invents a result: when evidence is absent the answer is `UNKNOWN`, and
`UNKNOWN` blocks — it is never upgraded to `PASS`.

## Where every stage lives

| Stage | Module | What it decides |
|---|---|---|
| Registry | `src/lib/strategy/runtime.ts` (+ `compiled/`) | what exists and whether it is deterministically evaluable |
| Validation run | `scripts/run-validation.mjs` (`npm run brain:validate`) | runs real backtests/OOS/walk-forward over TTT-derived data and persists one row per (strategy, symbol) |
| Persistence | `src/lib/backtest/experiments.ts` | append-only experiment rows + dataset identity + strict read-back |
| Ladder | `src/lib/backtest/validation.ts` | the highest empirical status the metrics support, with PASS/FAIL/UNKNOWN per criterion |
| **Gate** | `src/lib/backtest/promotion.ts` | promotion eligibility and the runtime status that follows from it |
| Governance ceiling | `src/lib/brain/gate.ts` | hard caps from source status, critical UNKNOWNs, conflicts, implementation binding |
| API | `GET /api/brain/validation` | the machine-readable record (never a fabricated result) |
| Runtime use | `src/lib/pipeline/orchestrator.ts` → `runtimeStatusFor()` | thin read of the gate; fails CLOSED |

## The A→F states (never collapsed into one boolean)

| State | Meaning | Where it is visible |
|---|---|---|
| **A** exists | the registry knows the strategy | `strategy_state.exists` |
| **B** executable | predicates are deterministic (`EXECUTABLE`) | `strategy_state.executable` |
| **C** validation evidence | at least one experiment persisted for it | `strategy_state.has_validation_evidence` |
| **D** OOS evidence | out-of-sample evidence exists for **every** symbol tested | `strategy_state.has_oos_evidence` |
| **E** promotion eligible | every gate check PASSes | `strategy_state.promotion_eligible` |
| **F** live eligible | E ∧ the governance ceiling allows `LIVE_ADVISORY_ONLY` | `strategy_state.live_eligible` |

`strategy_state.stage` names the highest state reached; the individual booleans
stay separate so "executable" can never be read as "live".

## Promotion gate checks (all deterministic, all mandatory)

1. `strategy_exists` — the strategy is in the runtime registry.
2. `strategy_executable` — availability is `EXECUTABLE` (no unresolved rules, no direction corruption).
3. `implementation_binding` — the Brain record carries an executable binding.
4. `source_status_usable` — `SOURCE_VERIFIED` / `SOURCE_INFERRED` only (a `CLAIM` is not evidence; `CONFLICT` must be adjudicated by the operator).
5. `no_unknown_critical` — entry/stop/target/timeframe/invalidation are stated in the corpus.
6. `no_unresolved_conflict` — a conflict group is never averaged away.
7. `validation_evidence_exists` — at least one experiment row.
8. `evidence_dataset_provenance` — a complete `DatasetIdentity`: TTT-derived source (`TTT_LIVE_SYNC` / `TTT_UDF_REPLAY`), capture time, sha256 of the exact artifact, and a fingerprint **recomputed** from the candles actually used, matching the experiment row. `FIXTURE_SYNTHETIC` can never back a promotion.
9. `evidence_versions_current` — `code_version`, `detector_version`, `strategy_version`, `rule_version` still describe THIS build, so a code change invalidates its own evidence.
10. `evidence_methodology_declared` — the row states the methodology it was produced under, and it is the current one.
11. `required_metrics_computed` — every required metric is non-null (a null metric is UNKNOWN, never a pass).
12. `evidence_verdict_reproducible` — the persisted status is re-derived from the stored metrics under the current criteria; a status that cannot be reproduced is refused.
13. `oos_evidence_exists` — an out-of-sample split with trades exists.
14. `evidence_quality_gate` — the ladder (`OOS_TESTED`/`WALK_FORWARD`/`ROBUST`) supports it, using the **weakest** result across all tested symbols.
15. `governance_ceiling_allows_live` — `brain/gate.ts` allows `LIVE_ADVISORY_ONLY` for the *evidenced* status.

    eligible = ALL checks PASS → otherwise `NOT_ELIGIBLE` with the exact
    `failed_checks`, `failure_reasons` and `unknown_reasons`.

## Runtime status

`runtimeStatusFor(strategyId)` reads the gate. `LIVE_ADVISORY_ONLY` is reachable
**only** through a fully satisfied gate; every other outcome is the
evidence-derived status clamped by the governance ceiling **and capped at
`PAPER`**, so strong-but-stale or provenance-less evidence can never leak a live
status. Any error fails CLOSED (`DISABLED`).

Live advisory output additionally requires the full gate at the admission step
(`brain/score.ts` → `requires_live_eligibility`), which the orchestrator sets in
live mode.

## Thresholds

`PROMOTION_CRITERIA` in `src/lib/backtest/validation.ts` is explicitly
ENGINEERING CRITERIA — the corpus states no statistical thresholds. They are
echoed in every verdict and are deliberately conservative
(min 30 in-sample trades / 15 OOS trades, PF ≥ 1.2, expectancy ≥ 0.05R,
max drawdown ≤ 15R, OOS retention ≥ 50 %, ≥ 3 walk-forward windows with ≥ 60 %
profitable).

## Running it

```bash
npm run brain:ingest     # brain.db: strategies, rules, governance state
npm run brain:validate   # real TTT replay data → experiments with provenance + verdicts
curl "$HOST/api/brain/validation" | jq '.counts'
```

A strategy with no evidence reports `NOT_VALIDATED` / `UNKNOWN` and stays
disabled. Increasing the number of live strategies is **not** the goal of this
pipeline; a trustworthy path to live eligibility is.
