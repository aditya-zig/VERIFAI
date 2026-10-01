# Start here

The shortest useful path for a fresh coding agent. Read this top to bottom once, then follow the sequence.

> **Never start implementing from memory or an old chat. GitHub + the current repository checkout are the implementation source of truth.**

> **Remote agent writes; local agent proves.** Before writing local feature code, check GitHub for an existing remote implementation and pull it first. The laptop supplies the real runtime acceptance. Read [`REMOTE-LOCAL-WORKFLOW.md`](REMOTE-LOCAL-WORKFLOW.md).

The local-agent kit is being built **incrementally**. If a referenced script does not yet exist, do not invent it — do the step manually or with the documented command, and note the gap in your handoff.

## Operating sequence

1. Read [`CURRENT-STATE.md`](CURRENT-STATE.md).
2. Check GitHub live state (commands are in `CURRENT-STATE.md`).
3. Read your assigned GitHub issue in full and check whether a remote PR/branch already implements it.
4. If remote work exists, fetch it and verify it instead of duplicating it. If not, create/check the issue branch.
5. Check branch and `git status` in the checkout.
6. Run the read-only preflight: `./ops/local-agent/scripts/preflight.sh` (LA1; run `npm run ops:test` after any kit change). If another referenced script does not exist yet, do the step manually and note the gap.
7. Confirm the baseline test for your area passes before changing anything.
8. Implement **only** the assigned issue, or make only evidence-backed integration/runtime fixes to pulled remote work.
9. Verify automated behavior: `./ops/local-agent/scripts/verify-local.sh` (LA5; runs only the checks present in the checkout, SKIPPED WITH REASON otherwise — never a fake PASS).
10. Verify real/manual behavior when the change is user-visible (browser/product check).
11. Push the branch and open or update the PR. Do not merge.
12. Leave a reproducible handoff: what changed, evidence, what remains, next smallest action.

## Non-negotiables

- One issue at a time. Read [`AGENT-RULES.md`](AGENT-RULES.md).
- Remote writes; local proves. GitHub is the handoff bus.
- Evidence over AI opinion; never invent PASS.
- Humans approve merges.
- Kit index: [`README.md`](README.md).
