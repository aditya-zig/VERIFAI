# Workflow

```text
GitHub issue
  -> issue branch
  -> failing test / RED
  -> minimal implementation
  -> targeted test
  -> full relevant E2E
  -> manual browser verification
  -> code review
  -> PR
  -> human merge
  -> next issue
```

Rules:

- Recheck issue acceptance criteria before coding.
- Prefer targeted proof first, then the broader relevant suite.
- Record real commands and outcomes in the PR/handoff.
- Do not open a duplicate milestone issue.
- Do not auto-merge.

If the master/local E2E path breaks, stop adding features and restore that path first.
