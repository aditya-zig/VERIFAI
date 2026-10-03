Snapshot only. Before coding, query GitHub for issue/PR/CI state.

## Stable context (low churn)

- Canonical repository: `aditya-zig/VERIFAI`
- Local machine: **8 GB RAM** — a hard limit, not a preference.

### Static project rules

- API-backed models only.
- No Ollama (do not install it).
- One heavy process/model/agent at a time.
- Docker is used only for the bounded local command; see [local scope and limits](../../docs/local-mvp.md).
- AWS-only model/runtime direction: Strands, AgentCore, and Bedrock (#74). This supersedes the earlier deferred AWS direction.
- Local development and tests remain bounded. Local AWS profiles/SSO or temporary credentials; AgentCore execution IAM role in the worker.
- Live AWS E2E requires explicit `VERIFIAI_RUN_AWS_E2E=1`, model ID, region, and authorized AWS access; presence checks are not live proof.
- Software factory deferred behind reliable M5 (#11).
- Humans merge. No auto merge.
- No fake PASS. Evidence over model claims; missing capability = Incomplete/Unknown.

### Roadmap references (states are live)

- #74 — current AWS-only Bedrock / Strands / AgentCore direction
- #4 — earlier local-first master roadmap / reset map
- #5 — M0 documentation
- #6 — M1 local repository clone (PR #19)
- #20 — M2 single API-backed analysis agent (PR #21)
- #9 — M3 real command execution
- #10 — M4 Docker sandbox
- #11 — M5 reliable master local E2E
- #12–#18 — later verification/runtime/cloud slices (planner slices)
- #22–#35 — Software Factory expansion map; blocked behind reliable M5

### Local-agent kit status

- #36 = local-agent bootstrap epic (`ops/local-agent/`).
- The kit contains tested preflight, Docker preparation, startup, shutdown and verification scripts. Consult the scripts and `npm run ops:test`, not historical slice status.
- **PR #37 = prototype/reference PR only.** It is NOT the clean implementation path. Do not merge it and do not continue building everything in it. Future LA slices may reuse verified material from it; PR #37 gets closed only after replacement slices are merged.

## Live project state (changes constantly — always re-query)

Everything issue/PR/CI/branch-specific is live state. Run these before coding, before review, and before writing any handoff:

```sh
gh issue list --repo aditya-zig/VERIFAI --state open

gh pr list --repo aditya-zig/VERIFAI --state all

gh run list --repo aditya-zig/VERIFAI --limit 5

git status --short --branch

git log -1 --oneline
```

Treat anything not confirmed by these commands (or by reading the issue itself) as potentially stale — including this file.
