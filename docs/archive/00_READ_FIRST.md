# AsA Agent Execution Package v1

This package is the implementation handoff for AsA. The goal is not another audit and not a greenfield rewrite. The agent must continue the included PROJECT and turn it into the production-ready advisory intelligence system described by the included constraints and knowledge.

## Authority order
1. `DOCS/MASTER_PROMPT_ASA_AGENT_EXECUTION_v1.txt` — execution instructions and acceptance gates.
2. `KNOWLEDGE/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json` + `strategy_registry.csv` + `rule_registry` — structured source of the user's strategy corpus.
3. `KNOWLEDGE/RAW_ORIGINAL/*.txt` — immutable original source for provenance and dispute resolution.
4. `DOCS/ASA_IMPLEMENTATION_CONTRACT_v1.md` — non-negotiable product/data/runtime contract.
5. `PROJECT/` — current implementation to improve, test, and finish.
6. `REFERENCE/` — supporting historical docs, research, TTT reference, and UI guidance. They are subordinate to the authority order above and must not silently override it.

## Security
This package intentionally contains **no real credentials**. `.env.local` was removed. Secrets must be injected by the agent/runtime through environment or secret storage and must never be committed, pasted into source, or returned in logs.

## Intended agent behavior
Work continuously in stages, implement code, run tests, inspect runtime behavior, fix regressions, and only stop when a hard blocker cannot be resolved from the supplied package. Do not merely report what is missing. Do not build fake data to satisfy a UI check.
