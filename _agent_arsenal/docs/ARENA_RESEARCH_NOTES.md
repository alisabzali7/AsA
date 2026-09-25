# Arena + MCP + Skills Research Notes

## Arena Agent Mode

Official Arena materials describe Agent Mode as a multi-step autonomous environment with built-in web search, image generation, file uploads, coding assistance, sandbox/bash, and GitHub-connected coding workflows. The GitHub workflow uses a sandbox copy of the repository, live diffs, preview, commit/push, and PR creation.

Public documentation also states that Agent Mode uses a dedicated orchestrator rather than exposing the model as a normal user-selected Battle Mode model. Arena may auto-switch models when a session is likely to fail. Therefore prompts should never claim a specific model identity unless the session proves it.

Arena's public docs also describe one PR per Agent Mode GitHub chat/session; once that PR is merged or closed, the session can no longer push additional work. This makes large coherent missions important.

Arena's Agent leaderboard evaluates agent behavior using signals including confirmed success, praise vs complaint, steerability, bash recovery, and tool hallucination. The practical implication is: maximize completed verified work, steerability, recovery, and zero hallucinated tooling.

## Skills

Strong open skill ecosystems include:
- Anthropic `anthropics/skills` with frontend-design and webapp-testing patterns
- Vercel `vercel-labs/agent-skills` with React performance and web design/accessibility guidance
- Superpowers-style agentic workflows emphasizing planning, TDD, systematic debugging, parallel investigation, and verification before completion

For AsA, local source-fidelity, systematic-debugging, frontend-visual-QA, fullstack-verification, orchestration, Git release, and MCP hygiene skills are more important than blindly installing a huge skill catalog.

## MCP

High-value compatible MCP candidates:
- Context7
- Microsoft Playwright MCP
- Chrome DevTools MCP
- shadcn MCP where relevant
- Vercel MCP if deployed on Vercel
- Sentry MCP if using Sentry

Arena's public Agent Mode docs do not currently document arbitrary user-configured MCP attachment. Do not claim these servers are active inside Arena without explicit UI/session evidence.

## AsA-specific opportunity

A read-only `asa-domain-mcp` would be more valuable than a pile of generic servers. It could expose structured repo/domain evidence such as market health, strategy inventory and traceability, psychology traceability, provenance, decision traces, signal traces, API contracts, and targeted checks.
