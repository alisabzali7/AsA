---
name: asa-fullstack-verification
description: Verify complete AsA features across frontend, API, backend, persistence, external data, and runtime. Use for end-to-end integrations and release validation.
---

# AsA Full-Stack Verification

A feature is not done because one layer works.

Verify:
USER ACTION → UI → provider → HTTP → API route → service → domain → persistence/external source → response → UI state

For every important feature record actual endpoint, input, output, error behavior, freshness, provenance, loading, empty, stale, runtime check, and tests.

Never hide backend failures with mocks.
Never invent endpoints.
Never fabricate values.

Release gate: typecheck, lint, targeted tests, integration tests, broader suite when practical, build, runtime smoke tests, browser checks where applicable.
