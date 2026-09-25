# AsA Agent Instructions

Read `ARENA_AGENT_OS_V2.md` before substantial work.

For domain-specific tasks, read the relevant skill under `.agents/skills/`.

Skill routing:
- large/autonomous mission → `asa-agent-orchestration`
- user source / Strategy / Psychology → `asa-source-fidelity`
- bugs/runtime/build failures → `asa-systematic-debugging`
- frontend/PWA/browser/RTL → `asa-frontend-visual-qa`
- cross-layer integration → `asa-fullstack-verification`
- Git/PR/release → `asa-git-release`
- MCP/tool selection → `asa-mcp-hygiene`

Never claim verification without evidence.
Never silently substitute mock data for production truth.
Never invent user methodology.
