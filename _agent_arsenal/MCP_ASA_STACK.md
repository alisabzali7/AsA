# AsA MCP Stack — Research-Based Recommendation

## Core principle

Do not attach every MCP server you can find. A large uncontrolled tool surface can increase tool-selection errors, context size, and security exposure.

Use a small high-value set and keep permissions scoped.

## Tier A — strongest fit

### 1. Context7
Repository: https://github.com/upstash/context7

Use for current version-specific documentation and examples for Next.js, React, TypeScript, charting, and other libraries.

Best trigger: before implementing or refactoring a library/framework integration where exact version behavior matters.

### 2. Playwright MCP
Repository: https://github.com/microsoft/playwright-mcp

Use for browser navigation, interaction, accessibility-tree inspection, form testing, screenshots, and runtime verification.

Best trigger: frontend runtime verification, regression testing, responsive checks, and end-to-end workflows.

### 3. Chrome DevTools MCP
Repository: https://github.com/ChromeDevTools/chrome-devtools-mcp

Use for live browser inspection, console/network debugging, screenshots, and performance analysis.

Best trigger: runtime defects that cannot be diagnosed reliably from source alone.

### 4. shadcn MCP
Repository: https://github.com/shadcn-ui/ui

Use for browsing/searching/installing registry components when AsA intentionally adopts a shadcn-compatible design system.

## Tier B — conditional

### 5. Vercel MCP
Official service: https://mcp.vercel.com

Use only if AsA actually uses Vercel for deployment/observability.

### 6. Sentry MCP
Repository: https://github.com/getsentry/sentry-mcp

Use only if AsA is connected to Sentry.

## Not first-line for Arena

Sequential Thinking, Filesystem, and Git reference MCPs are usually redundant with Arena's native planning, sandbox/bash, and GitHub integration. The Git reference server in particular is not a priority because of maturity/security concerns.

## Important Arena constraint

Arena's public Agent Mode documentation does not currently document arbitrary user-configured MCP server attachment. Therefore do not claim that any external MCP is active inside Arena unless the current interface/session explicitly shows it as connected.

Use this stack as a compatibility target for agent environments that support external MCPs, and use Arena-native capabilities first.

## Long-term AsA opportunity: domain MCP

Build an internal, initially read-only `asa-domain-mcp` that exposes evidence-rich inspection tools:

- asa_repo_map
- asa_runtime_health
- asa_market_truth_probe
- asa_strategy_inventory
- asa_strategy_trace
- asa_strategy_source_search
- asa_psychology_inventory
- asa_psychology_trace
- asa_provenance_lookup
- asa_decision_trace
- asa_signal_trace
- asa_api_contracts
- asa_validation_status
- asa_run_targeted_check

These tools should return structured evidence, not decisions.
Avoid arbitrary write tools initially.

## Security

MCP servers are powerful and may process untrusted content. Prefer least privilege, read-only modes, scoped credentials, sandboxing, explicit confirmation for destructive actions, and server-side authorization. Never treat tool annotations as a security boundary.
