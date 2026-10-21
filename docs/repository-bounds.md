# Repository clone bounds (admission and materialization)

PR80 F5. Every caller of `LocalRepositoryService.clone` (the web route in
`scripts/serve-web.mjs`, `master-audit.mjs`, `local-repair-service.mjs`) is
bounded by the service itself, so the limits hold without route changes.

## Limits and defaults

Constructor options on `LocalRepositoryService`. They are operator
configuration only. `clone(url, { signal })` accepts no limit overrides, so a
request body, candidate repository, or model output can never widen them. All
four must be positive integers or the constructor throws.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxWorkspaceBytes` | 100 MiB | Ceiling on regular-file bytes in the owned workspace. |
| `maxWorkspaceEntries` | 20,000 | Ceiling on directory entries in the owned workspace. |
| `maxRetainedWorkspaces` | 4 | Ceiling on retained cloned repositories per service. |
| `workspaceCheckIntervalMs` | 100 | Poll interval of the mid-materialization monitor. |

Defaults are exported as `defaultRepositoryBounds`.

## Admission, before side effects

`clone` checks, synchronously and in this order, before the ownership registry
is written, before the workspace directory exists, and before any process
spawn:

1. an already-aborted caller signal is rejected;
2. a clone already materializing is rejected (`Another repository clone is
   already in progress`), which enforces one materialization at a time;
3. a service already holding `maxRetainedWorkspaces` records is rejected
   (`Repository workspace limit reached`). A clone is never silently dropped or
   evicted; `cleanup(id)` frees a slot.

## Enforcement during and after materialization

While the owned `git clone` runs, a monitor polls the owned workspace
(`workspaceUsage`) and, on the first overrun, aborts the clone's owned
controller. That abort is the existing cancellation path: `runOwnedProcess`
kills the owned process tree with SIGKILL. The clone then fails with
`Repository materialization exceeded the workspace limit of N bytes|entries`
(statusCode 413) and the registered workspace and registry file are removed
through the same cleanup path as any other failure. The existing 119 s git
timeout and caller-cancellation semantics are unchanged.

Accounting rules in `workspaceUsage`:

- only the owned workspace is walked, incrementally per directory, and the walk
  stops the moment a ceiling is crossed, so accounting stays bounded by the
  ceilings rather than by the repository's shape;
- symlinks count as entries but are never followed, so neither target bytes nor
  target subtrees enter the account (a symlink farm cannot inflate or exhaust
  the walk);
- `.git` internal entries and bytes count like everything else, which makes the
  ceilings deliberately conservative;
- files that vanish mid-walk (git moves objects while writing) are skipped.

### Honest limitation: poll granularity

Detection is a poll, not a kernel quota. A materialization that both finishes
and exceeds a ceiling entirely between two polls is not aborted mid-flight.
That case is still rejected by a settled-workspace recheck before any success
record is written, so there is no silent partial success: an over-ceiling clone
is always rejected and cleaned up, but on very short clones the git process may
have already exited before the abort fires. With the 100 MiB / 20,000-entry
defaults, reaching a ceiling requires a materialization long enough that the
poller normally catches it in flight.

## Cleanup semantics

Unchanged and task-owned only: `cleanup(id)` removes exactly the workspace and
registry recorded for that id; `cleanupAll()` aborts in-flight clones, waits
for them to unwind, then removes retained records. Nothing else on the
filesystem is touched. Source policy is unchanged: public `https://github.com`
URLs only, no credentials.

## Tests

`ops/local-agent/tests/repository-bounds.test.mjs`, no network. Local git
fixtures and a controlled `runGit` process seam (constructor option) replace
the git clone call, so nothing downloads a repository. Run with:

```
node --test ops/local-agent/tests/repository-bounds.test.mjs
```

It proves: bounds options must be positive integers; byte and entry accounting
with symlinks never followed; a concurrent clone rejected before a second
spawn or second registry write; the retained cap rejected before any spawn,
freed by cleanup; byte and entry overruns aborting the running materialization
and removing the workspace; a clone finishing over the ceiling between polls
still rejected and cleaned (including a per-call override attempt); a tiny
valid clone accepted and retained; failed clones and cleanup leaving an
unrelated registered workspace and an outside sentinel directory untouched.
