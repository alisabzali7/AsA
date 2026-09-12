# Strategy Extension Guide

A strategy is a `StrategyDefinition` (`src/lib/strategy/index.ts`):

- metadata: id, family, status (`REFERENCE | RESEARCH_CANDIDATE | EXPERIMENTAL | VALIDATED | UNTESTED | DATA_LIMITED | REJECTED`), liveEligible, timeframes {macro, context, trigger}, directions
- `rules`: prerequisites/setup/trigger/confirmation/invalidation/stop/targets/regime/mtf/liquidity/psychology/derivativesFilters/sessionRules — every rule is a documented string; ambiguous rules are exactly `RULE NOT FORMALIZED`, never invented
- `params` + `paramNote` (research params are labeled as such)
- `evaluate(ctx) -> StrategyResult` with evidence[], failed[], strength, levels, thesis — the SAME function used live, in explanation, in the signal object, and in the backtest engine
- exit policy reads the shared `EXIT_POLICY`, which governs chart, Telegram, resolver and backtest identically

Register in `REGISTRY`; enable live in Settings (persisted `general.liveStrategyIds`).

## Future: user's ~300-page strategy document

Intended ingestion path (seam retained): PDF → structured canonical Strategy DSL/JSON → validator → compiled `StrategyDefinition`. Rule provenance fields to carry: rule_id, page_number, section, source_text, normalized rule, ambiguity status. Do NOT hardcode document rules into scattered conditionals.

## Backtest discipline

`runBacktest()` walks bars with no lookahead: features are computed on candles closed at/before the signal bar; entry fills at next open ± slippage; when SL and TP both touch a bar the STOP is taken first (conservative, documented in the UI); fees from TTT taker coefficient (auto), slippage an explicit assumption, funding NOT modelled (flagged). Small-sample/selection-bias warnings are part of the result object.
