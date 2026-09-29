# Workflow

```text
GitHub issue
  -> issue branch
  -> failing test (RED, confirmed)
  -> smallest implementation (GREEN)
  -> ./ops/local-agent/scripts/verify-local.sh
  -> manual check when user-visible
  -> push + PR (never merge)
  -> handoff with evidence
```

## Rules

- One issue at a time. Read [`AGENT-RULES.md`](AGENT-RULES.md).
- Re-read the issue acceptance criteria before coding.
- RED first: a new test must fail before the implementation exists.
  Record the failing count (e.g. "41 tests / 4 failures").
- Smallest GREEN: implement only the assigned issue, no refactors.
- Verify with the runner above, plus `npm run ops:test` after any kit
  change. Targeted proof first, then the broader relevant suite.
- If the master/local E2E path breaks, stop feature work and restore
  it first.
- Record real commands and outcomes in the PR and handoff.
- Do not merge. Humans approve merges.

## Kit sequence for local work

```bash
./ops/local-agent/scripts/preflight.sh        # read-only machine/repo report
./ops/local-agent/scripts/doctor.sh --stage M1  # readiness gates
./ops/local-agent/scripts/start-local.sh      # owned services up
# ... do the work, verify in browser ...
./ops/local-agent/scripts/stop-local.sh       # identity-verified stop
./ops/local-agent/scripts/cleanup-local.sh    # kit-owned state only
```

`start:api` (port 8787) SKIPs unless its build output and full OAuth
env block are present. That is normal on machines without those vars.
