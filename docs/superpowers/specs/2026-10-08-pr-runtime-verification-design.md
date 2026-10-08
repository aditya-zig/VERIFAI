# PR runtime verification: hackathon demo design

Status: proposed for human review; documentation only. Date: 8 October 2026.

## Goal and success

Give a coding agent an independent verifier for its actual GitHub PR. Verify the exact candidate revision with real execution on AWS, return actionable proof to the agent and publish the result on the PR. The agent can repair and rerun. A human remains responsible for merging.

Confirmed user direction: TREX-like runtime validation; full audit of code/GitHub/Pi/Notion; implementation plan delivered as a PR; hackathon demo first, pilot later. No new runtime resources or paid tests are authorized by the planning PR.

## Chosen scope and alternatives

Recommended: one approved public Node 22 HTTP service repository, one runtime profile and one real PR, with Strands/Bedrock planning and one AgentCore worker driving trusted execution tools. Reuse existing CodeBuild/ECR/Fargate lifecycle after hardening. A runtime bug must fail an actual request/test, and a repair must make the same independent expectation pass.

Alternative A: GitHub Actions runner first. Faster if AWS is unavailable, but it proves a hosted CI prototype, not AgentCore runtime parity. Label any such fallback explicitly and retain the AWS acceptance gate.

Alternative B: arbitrary repos plus browser/security/chaos swarms immediately. Larger setup/support and isolation surface; defer until the single-profile flow is reliable.

For the demo, controller state may use an atomic file-backed store on one operator-controlled host while workers execute in AWS. This is a hybrid demo and must be described that way. A fully cloud-hosted controller with DynamoDB/SQS/S3 is the pilot milestone, not a prerequisite for proving cloud worker execution.

## Global constraints

- Node.js 22 minimum; CI validation on Node 22.
- Strands Agents SDK + Amazon Bedrock AgentCore Runtime + Amazon Bedrock; no TrueForge or external-provider fallback.
- Humans approve repair PR publication; humans merge. No automatic merge.
- Missing required evidence produces Incomplete or Unknown; no success from skipped checks.
- One active verification job and one worker for the demo. Local heavy work remains sequential on the 8 GB machine.
- Initial target: approved public Node 22 HTTP service, committed npm lockfile, trusted runtime image/profile, no production secrets, databases or arbitrary stack discovery. Its approved dependency tree is prepared in the trusted image; candidate changes to dependencies, build configuration or native/install hooks are unsupported for the demo.
- Job timeout: 20 minutes including cleanup; reserve the last 2 minutes for cleanup. CodeBuild timeout: 15 minutes maximum; target task: 0.5 vCPU / 1 GiB initially. Unsupported requirements produce Incomplete; do not silently enlarge resources.
- Demo limits: at most 2 planner invocations, 1 worker with at most 8 tool calls, at most 4 generated tests, no automatic infrastructure retry, repository materialization at most 100 MiB / 20,000 entries, evidence at most 50 MiB/run, 8 KiB/command output stream, retention 7 days.
- An operator-set positive USD budget and authorized AWS configuration are required for a live run. Admission uses a conservative estimate/reservation for model, build, target and shared infrastructure; observed spend is separately labelled. AWS billing latency prevents a literal instantaneous dollar cutoff; time/count/resource stops are enforced and measured.
- Candidate code gets no GitHub token, model credential or controller credentials. Fixed test expectations and policy come from the approved base, not candidate-modifiable configuration.

## Contracts

Add to `packages/contracts/src/index.ts`:

```ts
type PrVerdict = 'Verified' | 'Failed' | 'Incomplete' | 'Unknown';
type PrJobPhase = 'Queued' | 'Resolving' | 'Planning' | 'Executing' | 'Cleaning' | 'Finished';
interface CandidateRevision {
  repository: string; pullRequest: number; headRepository: string;
  baseSha: string; headSha: string; mergeBaseSha: string;
  changedFiles: string[]; diffDigest: string;
}
interface PrVerificationRequest { repository: string; pullRequest: number; expectedHeadSha: string; }
interface CheckPlan {
  policyVersion: string; profileId: string; profileDigest: string;
  requiredChecks: TestDefinition[]; generatedTests: TestDefinition[];
  planDigest: string;
}
interface TestDefinition {
  checkId: string; artifactRef: string; contentSha256: string;
  origin: 'approved' | 'generated';
}
interface CheckObservation {
  checkId: string; revision: 'base' | 'head'; commitSha: string;
  status: PrVerdict; executed: boolean; exitCode: number | null;
  artifactRefs: string[]; commandDigest: string; testContentSha256: string;
}
interface PrVerificationResult {
  candidate: CandidateRevision; plan: CheckPlan; observations: CheckObservation[];
  verdict: PrVerdict; limitations: string[]; evidenceManifestSha256: string;
  cleanupComplete: boolean; superseded: boolean;
}
```

`Verified` means all required checks passed for the named revision/profile; it is not a blanket safety or mergeability guarantee. A failing executed required check gives Failed. Missing checks, unsupported setup, timeouts, budget exhaustion, contradictory provenance or unproven cleanup give Incomplete. Unreproduced allegations give Unknown. Superseded results remain readable but cannot publish success for a new head.

Persist immutable, content-addressed test artifacts before execution. The plan digest covers profile and test digests; observations bind the bytes actually executed. Restart must restore those same definitions, not regenerate tests. Missing or tampered definitions produce Incomplete. Execution tests the exact PR head separately from base, not GitHub's synthetic merge commit; the demo requires base to be an ancestor of head and strict up-to-date branch rules.

## Flow and trust boundaries

1. Authenticated agent calls `POST /api/pr-verifications` with repository, PR number and expected head. Resolve live GitHub metadata under repository authorization. Reject head mismatch with 409; bound/paginate diff enumeration and mark incomplete rather than silently truncate.
2. Pin base, merge-base, head repository and head SHA. The initial demo admits same-repository PRs only. Fork/private PR support remains pilot work.
3. Read changed functions, relevant callers and existing tests. Bedrock proposes experiments; server checks profile/tool/budget limits. Persist immutable plan and candidate digests. The repository cannot redefine trust policy.
4. Materialize base and head in separate disposable target runs. For the demo, use a prebuilt trusted Node image containing the approved dependency tree. Credentialed CodeBuild/ECR builds only the verifier-owned image from approved inputs; it never executes candidate source, Dockerfiles or dependency hooks. A trusted init stage fetches the immutable source as data with a short-lived read-only download capability, validates its digest and removes that capability before app startup. The Fargate task has no task role or mounted credentials. Use fixed startup/tests and reject dependency/build-profile changes as Incomplete. Arbitrary candidate builds need a separate credential-free build executor and trusted image publisher in the pilot. An approved Dockerfile alone does not isolate malicious npm hooks from the current privileged builder.
5. The AgentCore worker requests approved tools and receives execution observations. Fixed acceptance/regression tests run independently of candidate-authored scripts/results. Model-created tests run in a distinct test workspace with bounded APIs, not in the credentialed controller. The same generated tests run against both revisions; base failures are reported as pre-existing, never rewritten as candidate proof.
6. Collect command/API output, provenance, immutable artifact digests and app identity. A browser test is optional in the first API-only demo; UI parity must run against the actual candidate when introduced, not the local browser fixture.
7. Independently stop CodeBuild when necessary, stop target task and AgentCore session, verify terminal states and persist ownership/outcome. Unknown cleanup blocks a terminal success and blocks new admission until reconciled.
8. Finalize deterministically. Re-fetch PR head and base; mark stale jobs superseded and rerun. Publish `VERIFAI / runtime` Check Run on the exact head SHA plus one updatable evidence comment. Required check config must identify the expected GitHub App, require branches up to date before merging, and apply without operator bypass during acceptance. Base must be an ancestor of head at admission/publication. A later base update requires branch update and explicit rerun, so the previous head's success cannot satisfy the demo gate. Incomplete maps to `action_required`, Unknown also maps to `action_required`, Failed to `failure`, Verified to `success`; test that the selected rules block non-success. If strict rules cannot be enforced, label the result advisory and do not claim a merge gate.

## Interfaces for agents and humans

- `POST /api/pr-verifications` → 202 `{jobId, phase:'Queued'}`; scoped agent credential, required idempotency key.
- `GET /api/pr-verifications/:jobId` → authorized candidate, phase, result, limitations and artifact links.
- `POST /api/pr-verifications/:jobId/cancel` → idempotent cancellation request; cleanup proceeds.
- `GET /api/pr-verifications/:jobId/artifacts/:artifactId` → owner-authorized bytes; pilot uses short-lived private S3 access.
- Thin CLI: `verifai verify-pr <repository> <number> --head <sha>`, `status`, `cancel`; MCP wraps the same interface, never another execution path.
- Human evidence view shows revision, required coverage, Expected/Observed, logs and cleanup. An authenticated human approval endpoint records identity and binds exact evidence/patch before optional repair PR publication. An agent cannot turn its own call into human approval.

Demo verification can be started explicitly; automatic signed GitHub webhook intake is pilot work. GitHub App installation credentials stay in the trusted publishing/controller boundary. No `pull_request_target` workflow executes untrusted candidate code with write credentials.

## Persistence, recovery and migration

Extend existing contracts and adapter seams; add a PR service beside the local audit and retain that narrow local flow. Do not translate every Completed audit into Verified PR. Share evidence semantics, not fake aliases across the two APIs.

Store job/candidate/plan/resource identifiers before side effects. Atomic file storage supports one controller for the demo; startup reconciliation marks abandoned work Incomplete and stops only confirmed owned resources. Resource IDs discovered after a crash are reconciled by run tags; absence of a response is not proof of absence. Pilot migrates this interface to conditional DynamoDB writes, SQS leases and private S3 evidence. Avoid an unrelated factory/intake rewrite.

## Release gates

1. F1–F3 fixed; malformed HTTP input cannot stop the service; agent cannot authorize repair publication; intake quotas are enforced.
2. Current Bedrock local baseline and one AgentCore worker produce real execution and cleanup evidence; #11/#18/#74 updated only from actual acceptance.
3. An actual bug PR fails a fixed API assertion while base passes. An actual fixed revision passes original check plus independent regression. Assert exact changed commit/app identity.
4. An unrelated good PR passes without an invented failure. Unsupported repo, missing model/engine, stale head/base, removed tests, cancellation, worker death and cleanup failure never publish success.
5. Three consecutive bad→fixed cycles with distinct jobs/fresh targets and no manual resource repair; preserve failures too. Existing #11 ten-run local acceptance remains separate.
6. GitHub Check and evidence comment point to the tested head; new push cannot reuse the old success. Advance base after a green run and prove merging is blocked until branch update and rerun. Proof identifies head execution rather than a synthetic merge candidate. A human merge under tested strict rules is possible only after required checks and review.
7. Archive manifests, request logs and resource terminal observations; record actual/estimated cost distinction and shared infrastructure cost. Publish a truthful recording.

## Pilot scope

Signed webhook deduplication and reruns; fully hosted durable controller; private/fork repositories with installation-scoped access; tenant/job ownership; real app browser journeys where applicable; independent repair/regression adapter; additional profiles; merge-group/base-update handling; image/dependency pinning; auth/recovery/security review; evaluation dashboard. General software-factory implementation, mass user simulation and every external engine are outside this release.
