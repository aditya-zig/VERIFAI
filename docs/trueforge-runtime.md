# TrueForge runtime parity preparation (M11 #17)

Status: **IMPLEMENTED — REAL TRUEFORGE PROOF PENDING**

Reference product contract: PR #60 head 86557a45636fd7e2a1965113cb60883173b5f3f0.

## Contract boundary

VERIFAI owns the product semantics. The shared runtime engine preserves the existing run object: id, exact repository commit, M5 stage names, terminal status, finding plus executed evidence, specialist/browser/repair/proof state, approval/PR state, cleanup and provenance.

Runtime adapters only change where work runs.

- LocalRuntimeProvider maps the contract to existing repository/model/sandbox operations.
- TrueForgeRuntimeProvider uses TrueForge for the model turn and server-authorized bounded tools for repository/execution/browser/repair/artifact operations.
- All runtime results pass through the same runRuntimeAudit state machine.

## Old PR #1 audit

### REUSE

- REST + SSE TrueForge client approach.
- Session creation and terminal turn handling.
- Explicit timeout/cancellation behavior.
- Signed scope concept.
- Rule that executed evidence comes from tool results, not model prose.

### ADAPT

- Model selection is now one configured model behind the common runtime adapter.
- Scope binds runId, exact repository commit, worker identity, capabilities, repair permission and tool-call ceiling.
- Tool catalog is reduced to the current product needs.
- Evidence is normalized into the existing M5/M6-M10 run object instead of the old worker schema.

### DELETE / OBSOLETE / NOT NEEDED

- Old planner and dynamic worker fan-out.
- Old multi-agent product architecture.
- Target/performance/chaos tool catalog unrelated to current M5-M10 behavior.
- Separate weaker TrueForge-only acceptance tests.

### UNSAFE — NOT PORTED

PR #1 placed the signed scope token inside model-visible tool arguments. M11 does not do this. Authorization stays server-side. If the installed TrueForge connector cannot bind per-run authorization without exposing it to the model, that capability must return **Incomplete** rather than weakening the boundary.

## Scoped capabilities

Default scoped tools are:

- repo_tree
- repo_read
- bounded_execution
- browser_journey only when required
- repair_candidate only with explicit repair authorization
- artifact_handoff only when artifacts are required

Every scope binds the exact run and repository commit and enforces a bounded call count.

## Static verification

Run:

    npm run runtime:contract
    npm run typecheck

The runtime contract suite executes the same assertions against local and TrueForge fixtures for success, provider unavailable, command failure, required browser unavailable, rejected repair, missing artifact, timeout, cancellation, cleanup failure and stale approval.

These tests prove semantic/static parity only. They do not prove a real TrueForge service, model, browser, repair flow, or GitHub PR.

## Live boundary

A real M11 PASS still requires the laptop/runtime environment to provide an authorized TrueForge service plus the server-side scoped tool transport and run the unchanged product acceptance assertions. Until then the milestone remains runtime-proof pending.
