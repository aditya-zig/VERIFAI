# Start here

The shortest useful path for a fresh coding agent. Read this top to bottom once, then follow the sequence.

> **Never start implementing from memory or an old chat. GitHub + the current repository checkout are the implementation source of truth.**

The local-agent kit is being built **incrementally**. If a referenced script does not yet exist, do not invent it — do the step manually or with the documented command, and note the gap in your handoff.

## Operating sequence

1. Read [`CURRENT-STATE.md`](CURRENT-STATE.md).
2. Check GitHub live state (commands are in `CURRENT-STATE.md`).
3. Read your assigned GitHub issue in full.
4. Check branch and `git status` in the checkout; create the issue branch if needed.
5. Run the read-only preflight: `./ops/local-agent/scripts/preflight.sh` (LA1; run `npm run ops:test` after any kit change). If another referenced script does not exist yet, do the step manually and note the gap.
6. Confirm the baseline test for your area passes before changing anything.
7. Implement **only** the assigned issue.
8. Verify automated behavior (tests/typecheck relevant to the change).
9. Verify real/manual behavior when the change is user-visible (browser/product check).
10. Push the branch and open or update the PR. Do not merge.
11. Leave a reproducible handoff: what changed, evidence, what remains, next smallest action.

## Non-negotiables

- One issue at a time. Read [`AGENT-RULES.md`](AGENT-RULES.md).
- Evidence over AI opinion; never invent PASS.
- Humans approve merges.
- Kit index: [`README.md`](README.md).
