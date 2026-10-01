# Remote/local implementation workflow

## Primary rule

> **Remote agent writes; local agent proves.**

Use this split whenever a remote coding agent can work faster than the resource-constrained laptop.

## Remote implementation agent

The remote agent owns work that can be developed and tested without claiming laptop-runtime proof:

- implementation code and narrowly scoped refactors required by the assigned issue;
- unit, contract, and other automated tests it can genuinely execute;
- one branch / PR per milestone or clearly documented stacked PRs;
- exact handoff instructions under a **LOCAL VERIFICATION REQUIRED** section.

The remote agent pushes work to GitHub and continues independent work instead of waiting for the laptop after every milestone.

The remote agent must **not** claim local browser, Docker, model/provider, RAM, process-cleanup, or hardware-specific PASS unless it actually executed that proof.

## Local integration and verification agent

The local agent is the runtime truth gate.

Before writing feature code it must:

1. check the current GitHub issue / PR state;
2. pull an existing remote implementation when one exists;
3. inspect the diff and run its targeted tests;
4. execute the real laptop acceptance path;
5. fix only evidence-backed integration/runtime defects.

Local proof includes, as applicable:

- real API-backed model execution;
- real Docker sandbox lifecycle;
- real browser journey;
- 8 GB laptop resource behavior;
- process / container / temporary-workspace cleanup;
- final master E2E.

The local agent must not reimplement remote work from scratch merely because it has not read that branch yet.

## GitHub is the handoff bus

Remote and local agents coordinate through GitHub issues, branches, PRs, and comments.

Every remote PR that needs laptop proof must state:

- what is implemented;
- what automated tests actually ran;
- what is **not** proven remotely;
- exact local verification commands / actions;
- expected observable evidence;
- cleanup checks.

When the local agent finds a structural defect, it should comment exact reproduction evidence on the remote PR. A tiny laptop-specific integration fix may be made locally; larger non-local fixes stay with the remote implementation owner.

## Resource rule

Parallelize **coding**, not heavy laptop execution.

On the 8 GB laptop keep heavy validation serial:

- one model call at a time;
- one Docker sandbox at a time;
- one browser at a time.

## Cloud is separate

This workflow does not make the remote implementation agent the cloud product owner.

Cloud/runtime work must preserve the locally proven contract. Local behavior and evidence semantics remain the reference; cloud changes where the work runs, not what counts as verified.
