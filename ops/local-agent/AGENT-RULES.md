# Agent rules

- One canonical issue at a time.
- One issue -> one branch -> RED -> smallest GREEN -> verification -> PR.
- No unrelated refactors, dependency upgrades, or architecture redesigns.
- Use TDD where the behavior can be tested. Confirm RED before implementation.
- Prefer the smallest implementation that satisfies the issue.
- Tests passing are not enough for user-facing work; manually verify the real browser flow.
- No mocks, fake findings, fake engine output, or fake PASS states in acceptance paths.
- Evidence decides. Model claims do not.
- Humans merge. Never auto-merge.
- After two evidence-backed attempts at the same blocker, stop and hand off the exact failure and next smallest test.
- Never print, commit, paste, or log API keys/secrets.
- Keep the 8 GB laptop responsive. Run one heavy process/model/engine at a time.
- Docker is not part of M1/M2/M3 unless the canonical roadmap changes.
- Do not start AWS, Vercel, TrueForge, or software-factory work before its gate.
