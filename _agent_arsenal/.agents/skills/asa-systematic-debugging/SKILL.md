---
name: asa-systematic-debugging
description: Diagnose AsA defects by reproducing failures, tracing root causes across layers, fixing the real cause, and adding regression coverage. Use for runtime errors, market loading failures, API failures, build failures, and integration bugs.
---

# AsA Systematic Debugging

Do not patch symptoms before identifying the failing layer.

Method:
1. reproduce
2. capture exact error output
3. identify first failing boundary
4. trace upstream/downstream dependencies
5. form root-cause hypotheses
6. gather evidence
7. make structural fix
8. add regression coverage where practical
9. verify
10. rerun adjacent workflows

Trace UI → provider → API → service → domain → persistence/external source.
For TTT: TTT → transport → normalization → history → MTF state → API → UI.

Never suppress errors, silently use fake data, loosen validation solely to pass tests, delete tests that expose bugs, or claim a fix without evidence.
