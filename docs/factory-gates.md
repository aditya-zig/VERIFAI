# Deterministic factory foundation

Agents propose changes. Server-owned code decides whether they can advance.
Skills and prompts explain the process; they cannot grant verification or PR
permission. Issue #76 hardens the existing repair-to-PR path for roadmap #22.

`services/repair-verification-policy.mjs` is the shared policy used after local
repair verification and again before PR approval or any GitHub call.

| Required fact | Code enforcement |
| --- | --- |
| Original check actually failed | Failed status, executed flag, integer nonzero exit and named command |
| The same check passed after repair | Exact same command, Completed status and executed zero exit |
| Regression checks ran | At least one, at most eight; every named check executed and passed |
| Checks were uninterrupted | Timeout/cancellation cannot count as success |
| Candidate has exact provenance | Patch digest and unique, matching before/after file hashes |
| Original workspace is intact | Integrity check passes |
| Candidate is removed | Cleanup must finish successfully |
| Human approved these facts | Approval binds the full repair and proof metadata |

A missing or inconsistent required fact cannot yield `VerifiedRepair` or create
a PR. Approval becomes stale if verification output, provenance, file hashes or
proof metadata change. GitHub writes use an isolated snapshot so caller mutation
during an awaited read cannot replace the approved candidate.

Approval tokens use version 2; older tokens must be reissued from current
verified evidence. Merge remains an explicit human action.

These gates check records produced by trusted execution adapters. They do not
authenticate arbitrary agent-authored JSON as evidence. One passing command
proves only that command's scope. Replaying it as a regression remains labelled
same-command replay, not independent coverage.

The complete factory intake, approved specs, risk review, durable controller,
event history and issue-to-PR E2E remain open in #23–#35. Reliable master audit
acceptance (#11) and live AWS acceptance (#18) are still pending. This foundation
adds no agent, model call, deployment or background service.

Verification: `npm run check`. PR CI also runs the structural Docker E2E and
local-agent kit tests. Regression tests exercise the real policy through the
repair verifier and PR boundary; controlled adapters are not live AWS proof.
