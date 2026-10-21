# Non-AWS integration

Issue #89 connects PR intake, durable local jobs, approved check policy,
evidence, authenticated agent access and review interfaces. Live AWS acceptance
remains separate in #18 and #74. No cloud resource is created by setup.

## Start

Use a disk-backed working directory with Node 22 or later and installed npm
dependencies. `npm start` compiles the services, then starts the owned local web
and API processes. Open `http://127.0.0.1:4173`.

The header separates Local audit, Deep audit and PR verification. Local audit
is one bounded repository check. Deep audit exposes the legacy engine flow and
must disclose missing engines and fixture coverage. PR verification targets an
exact PR base/head. None of these labels implies full security verification.

## Configure trusted local access

Keep credentials in the backend's protected, ignored `.env.local` or launching
environment. Never put credentials in tracked files, URLs or command arguments.

- `VERIFIAI_LOCAL_PRINCIPALS_JSON` configures scoped human and agent principals.
  See `services/request-principal.mjs` for the schema and minimum token length.
- `VERIFIAI_PR_STATE_DIR` optionally selects private persistent job storage.
  The default is `data/pr-verification` under this project.
- `VERIFIAI_PR_PROFILE_PATH` selects a backend-owned approved check profile.
  `config/pr-demo-profile.json` explains the narrow profile shape; its example
  hashes are not evidence of an installed image or dependencies.
- `VERIFIAI_GITHUB_TOKEN` or `GITHUB_TOKEN` optionally authenticates read-only
  candidate resolution. It is never sent into a candidate application.

The local agent CLI reads its separate `VERIFIAI_AGENT_TOKEN` from the caller's
environment. `node scripts/verifai-job.mjs --help` lists start, status, cancel,
evidence and capabilities. The browser token field retains a token only in
memory. Reloading does not restore it.

## What is deliberately unavailable without execution

Missing approved policy stops planning. Missing runtime execution stops the job
with Incomplete, no observations and an explicit unavailable-executor reason.
An unconfigured model makes no inference call and leaves generated tests empty.
Persisting a plan, resolving a PR or rendering a result cannot create a pass.

The shipped runtime never supplies a synthetic executor. Real base/head app
execution still needs a trusted execution adapter and its live acceptance.
The non-AWS tests use controlled adapters to exercise contracts, including
failure, cancellation, ownership, restart and cleanup. Those tests are not
evidence that a submitted application ran in AWS.

## Publication

GitHub Check publication needs backend `VERIFIAI_GITHUB_APP_TOKEN`, explicit
`VERIFIAI_PR_STRICT_BRANCH_PROTECTION_ACK=1` and an authenticated human request
against a stored terminal job result. The acknowledgment does not configure
or prove branch protection. The agent client cannot publish or merge.

Repair PR publication additionally requires an evidence-bound human approval
issued and consumed through separate actions. Approval cannot replace missing
verification, and code never merges a PR automatically.

## Verify

Run these sequentially on the final revision:

```sh
npm run check
npm run ops:test
node --test tests-p1/pr-runtime-integration.test.mjs
```

Use installed Chrome to check the three screens at desktop, tablet and phone
widths. Exercise loading, invalid input, authentication rejection, Incomplete
jobs, cancellation and retained job reads. Inspect console/network errors.
Do not run paid inference or a live AWS acceptance command without separate
authorization. Record skipped capabilities as skipped, not passed.

References: `docs/pr-candidate-resolution.md`, `docs/pr-jobs.md`,
`docs/pr-check-policy.md`, `docs/pr-http-api.md`, `docs/pr-github-checks.md`,
`docs/repository-bounds.md` and `docs/factory-gates.md`.
