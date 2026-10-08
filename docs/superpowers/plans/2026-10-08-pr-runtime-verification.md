# PR Runtime Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coding agent verify its exact GitHub PR through real AWS execution, receive actionable evidence and publish a commit-bound result before human merge.

**Architecture:** Preserve VERIFAI's existing local verifier and shared evidence/repair policy. Add a PR controller that pins candidate identity, executes a trusted Node service profile using the existing AWS lifecycle and AgentCore worker, then finalizes proof and publishes a GitHub Check. Start with one controller and one job; move the same persistence interface to managed cloud storage/queue for the pilot.

**Tech Stack:** Node 22+, TypeScript/ES modules, existing Strands SDK/Bedrock/AgentCore, CodeBuild/ECR/ECS Fargate, GitHub App Checks API; atomic file state for the hybrid demo, DynamoDB/SQS/S3 for the fully hosted pilot.

**Spec:** [PR runtime verification design](../specs/2026-10-08-pr-runtime-verification-design.md). **Audit:** [progress and findings](../../audits/2026-10-08-pr-verification-audit.md). Baseline: `b88775d1defa1dd3152426c89f13a4028551799e`.

## Global Constraints

The spec is authoritative for the exact bounds below. These values are proposed demo limits, not a claim existing services already enforce them.

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

## Review Focus

1. PR head/base changes between resolution, execution and publication: retain old proof but never publish success for a different candidate (Tasks 2, 7).
2. Candidate removes tests, weakens assertions or changes verifier config: preserve approved expectations and disclose policy changes (Tasks 3, 5).
3. API/controller dies after cloud allocation but before recording a response: reconcile owned tagged resources and block success/new work until cleanup is proven (Tasks 4, 6).
4. Authenticated agent can verify but cannot impersonate a human approver or access another owner's job/artifacts (Tasks 1, 8, pilot P1).
5. A base test fails or a generated test is flaky: record pre-existing/uncertain evidence without claiming candidate regression or successful proof (Tasks 5, 9).

---

## Delivery sequence and effort

| Milestone | Tasks | Rough effort for one experienced engineer using agent assistance | Gate |
| --- | --- | --- | --- |
| Safety and current acceptance | 1, then current live proof | 1–3 engineering days plus access/blocker time | F1–F3 fixed; current local/AgentCore evidence |
| Candidate identity and execution | 2–5 | 4–7 engineering days | Real PR tested with fixed expectations |
| End-to-end demo | 6–9 | 3–5 engineering days | GitHub Check + agent repair/rerun + repeated cleanup proof |
| Fully hosted pilot | P1–P3 | Additional 2–4 weeks, staffing/access dependent | Durable multi-user cloud operation and evaluation |

Combined demo planning range: **8–15 engineering days**, excluding provisioning approvals, model entitlement and unexpected integration failures. This is not a calendar commitment or measured percentage complete. If the event is sooner, cut to one public Node API PR, one fixed regression and one generated targeted check; defer automatic webhooks, browser lanes, autonomous repair authoring and broad stack support. Do not cut exact revision identity, independent assertions, caller authorization or cleanup.

Current GitHub issues to reconcile: #11 (current local reliability), #18/#74 (live AWS parity), #28 (arbitrary candidate gate), #27 (review/risk gate), #15/#16 (proof/PR), #32 (durable state). Implement through scoped issues/PRs in this order; this planning PR closes none of them. Roles are suggested work boundaries, not assignments to unconfirmed teammates.

## File map

| Area | Existing seam | Proposed files |
| --- | --- | --- |
| HTTP/approval | `scripts/serve-web.mjs`, `services/local-pr-service.mjs` | `services/request-boundary.mjs`, `services/human-pr-approvals.mjs` |
| PR identity | `packages/core/github/index.ts`, contracts | `services/pr-verification/candidate.ts` |
| Planning and policy | existing Strands planner, worker tools | `services/pr-verification/profile.ts`, `planner.ts` |
| Controller/state | `apps/api/server.ts`, existing project/store patterns | `services/pr-verification/store.ts`, `controller.ts`, `routes.ts` |
| Execution | `services/bootstrap/aws-target-lifecycle.ts`, worker launcher | `services/pr-verification/executor.ts`, `evidence.ts`, `verdict.ts` |
| Recovery | existing owned-resource lifecycle | `services/pr-verification/recovery.ts` |
| GitHub feedback | existing transport | `services/pr-verification/github-checks.ts` |
| Agent/UI | `apps/web/index.html`, HTTP API | `scripts/verifai-pr.mjs`, `services/pr-verification/mcp.mjs` |
| Live acceptance | existing scripts/test layout | `scripts/pr-runtime-acceptance.mjs`, `config/pr-demo-profile.json`, `tests/pr-verification/*.test.ts` |

Test files listed below are proposed, not existing. Existing `npm test` currently runs only `dist/tests/*.test.js`: Task 2 must add the new subdirectory invocation. Do not mistake unexecuted nested tests for coverage.

### Task 1: Close audited safety gaps before new remote execution

**Files:** create `services/request-boundary.mjs`, `services/human-pr-approvals.mjs`; modify `scripts/serve-web.mjs`, `services/local-pr-service.mjs`, `services/local-repository.mjs`, `services/bootstrap/aws-target-lifecycle.ts`; test `tests-p1/request-boundary.test.mjs`, `tests-p1/human-pr-approval.test.mjs`, `tests/aws-target-lifecycle.test.ts`, `tests-e2e/command-safety.test.mjs`.

**Interfaces:** `RequestPrincipal = {id:string, kind:'human'|'agent', repositories:string[]}`. `authorizeMutation(request, {principals, allowedOrigins, allowedHosts}): RequestPrincipal`; credentials are supplied by operator-owned configuration, not repository data. `recordHumanApproval({principal,auditId,repair,proof}): {approvalId:string}`; `consumeHumanApproval({approvalId,principalId,auditId,repair,proof}): void` binds identity/evidence, expires after 15 minutes and is single-use. Change `LocalPrService.create(auditId,{principal,approvalId})`; it consumes existing human authorization and cannot mint it implicitly. Browser requests require Origin/Host/CSRF validation; CLI/MCP uses scoped bearer auth and may omit Origin.

- [ ] Write `rejects_text_plain_external_origin`, `agent_cannot_issue_human_approval`, `approval_is_single_use_and_stale_after_patch_change`, and `malformed_audit_id_returns_400_and_health_survives`. Assertions: no clone/publish call on rejection; HTTP 400 for `%ZZ`, health 200 afterward; missing bearer 401; wrong repository 403.
- [ ] Write buildspec tests for `Dockerfile; echo marker #`, newline, traversal and symlink; reject before `StartBuild`. Prove accepted `docker/Dockerfile` stays one quoted shell argument. Add direct-clone concurrency/byte-limit assertions; over-limit requests abort and clean only owned workspaces.
- [ ] Run new tests and confirm RED; record actual failure, not an assumed one.
- [ ] Add top-level request error handling/safe decodes, scoped auth/approval seam and all-intake admission. Enforce 100 MiB/20,000-entry materialization caps. Validate tracked regular Dockerfile paths and quote every shell/diagnostic use; do not expose arbitrary caller buildspecs.
- [ ] Run `npm run check`, `npm run ops:test` and the targeted API tests; confirm GREEN. Run current authorized local/AgentCore acceptance separately and attach evidence to #11/#18/#74. Missing access leaves those gates pending.
- [ ] Commit the smallest reviewed safety change(s); no product expansion in these PRs. Preserve pre-existing files and never merge automatically.

### Task 2: Define and resolve immutable PR candidates

**Files:** modify `packages/contracts/src/index.ts`, `package.json`; create `services/pr-verification/candidate.ts`; test `tests/pr-verification/candidate.test.ts`.

**Interfaces:** use `CandidateRevision`, `PrVerificationRequest`, `PrJobPhase`, `PrVerdict`, `CheckPlan`, `CheckObservation`, `PrVerificationResult` exactly as defined in the spec. `resolveCandidate(input:PrVerificationRequest, principal:RequestPrincipal, transport:GitHubTransport): Promise<CandidateRevision>`. Reuse `GitHubTransport.request<T>` from `packages/core/github/index.ts`; adapt principal type to an exported TS declaration at the boundary.

- [ ] Write tests `resolves_head_and_base_from_live_pr`, `rejects_expected_head_mismatch`, `rejects_fork_in_demo`, `requires_repo_permission`, `incomplete_on_truncated_diff`, `base_change_changes_identity`, `base_must_be_ancestor_of_demo_head`. Assert returned repository/head repository, 40-character SHA identity, changed-file list and SHA-256 diff digest; head mismatch 409; unauthorized 403. Proof names head-only execution, not a synthetic merge candidate.
- [ ] Add package script `test:pr-verification` as `npm run build && node --test dist/tests/pr-verification/*.test.js`; invoke it in `check`. Run and confirm RED.
- [ ] Resolve/paginate metadata and files, bound combined response/materialization to demo limits, fail closed on overflow. Fetch exact objects, compute merge-base/diff identity; never use a mutable default branch as candidate.
- [ ] Run `npm run test:pr-verification` and existing GitHub tests; confirm GREEN, including missing PR/revision and deleted branch responses.
- [ ] Commit `feat: resolve immutable PR verification candidates`.

### Task 3: Plan from changes under trusted execution policy

**Files:** create `services/pr-verification/profile.ts`, `planner.ts`, `config/pr-demo-profile.json`; modify existing `services/orchestrator/strands-orchestrator.ts` only at its planning seam; test `tests/pr-verification/planner.test.ts`.

**Interfaces:** `VerificationProfile = {id:string,policyVersion:string,repository:string,basePolicyCommit:string,requiredChecks:TestDefinition[],runtimeImageDigest:string,dependencyTreeDigest:string,healthPath:string,allowedToolNames:string[],maxGeneratedTests:number}`. `loadApprovedProfile(profileId:string): VerificationProfile`; `planCandidate(candidate:CandidateRevision,profile:VerificationProfile,context:string,signal:AbortSignal): Promise<CheckPlan>`; `validatePlan(plan:CheckPlan,profile:VerificationProfile): void`. Fixed profile identifies trusted Node API startup, existing regression suite and one HTTP invariant. Configuration belongs to the verifier/approved base; PR changes are proposals requiring review. Persist content-addressed `TestDefinition` bytes before execution; profile/plan digests cover all test-content digests.

- [ ] Write tests `changed_function_and_callers_are_in_context`, `candidate_cannot_remove_required_checks`, `generated_test_count_capped_at_four`, `untrusted_readme_cannot_grant_tools`, `planner_timeout_yields_incomplete`, `test_definition_tampering_invalidates_plan`. Assert fixed check IDs/content digests remain present and unsupported tool names are rejected.
- [ ] Run `npm run test:pr-verification`; confirm RED.
- [ ] Select changed-code context with explicit omission metadata; use current Strands/Bedrock model seam. Validate model output server-side, cap at 2 invocations/4 generated tests, and persist/hash test definitions and plan/profile. Only allow approved tool identifiers; no arbitrary model shell in controller.
- [ ] Run targeted and existing planning/orchestrator tests; confirm GREEN. Model fakes prove contract behavior only; Task 9 proves actual planning.
- [ ] Commit `feat: plan bounded checks for PR changes`.

### Task 4: Admit, persist and cancel PR jobs

**Files:** create `services/pr-verification/store.ts`, `controller.ts`, `routes.ts`; modify `apps/api/server.ts`; test `tests/pr-verification/controller.test.ts`.

**Interfaces:** `PrJob = {id:string,ownerId:string,request:PrVerificationRequest,candidate?:CandidateRevision,plan?:CheckPlan,phase:PrJobPhase,cancelRequested:boolean,resourceIds:ResourceRecord[],result?:PrVerificationResult}`. `ResourceRecord = {kind:'build'|'target'|'session',id:string,runId:string,cleanupState:'pending'|'stopped'|'unknown'}`. `PrJobStore.put(job:PrJob,expectedVersion:number|null): Promise<number>`; `get(id:string): Promise<{job:PrJob,version:number}|undefined>`; `listUnfinished(): Promise<PrJob[]>`. `PrVerificationController.start(input,principal,idempotencyKey): Promise<PrJob>`; `get(id,principal): Promise<PrJob>`; `cancel(id,principal): Promise<void>`.

- [ ] Write `duplicate_start_returns_same_job`, `second_distinct_job_is_429_before_model_or_build`, `wrong_owner_cannot_read_or_cancel`, `restart_retains_candidate_plan_and_resource_ids`, `restart_restores_exact_test_artifact_bytes`, `cancel_is_idempotent`. Assert no downstream side effect without committed state/version; restart never regenerates planned tests.
- [ ] Run and confirm RED.
- [ ] Implement atomic file store using existing persistence patterns, one controller lease and admission budget reservation. Wire spec routes under authenticated boundary. Persist Queued before work, resource allocation intent/tags before AWS calls and IDs immediately after response. Keep legacy local audit routes semantically separate.
- [ ] Run controller/API tests; simulate interruption between allocation and response and retain reconciliation intent. Confirm GREEN; no paid operations in these tests.
- [ ] Commit `feat: persist and control PR verification jobs`.

### Task 5: Run actual base/head applications and independent assertions

**Files:** create `services/pr-verification/executor.ts`, `evidence.ts`; modify `services/bootstrap/aws-target-lifecycle.ts`, `services/agent-runtime/worker-tools.ts`, `infra/aws/real-target-stack.yml`; test `tests/pr-verification/executor.test.ts`.

**Interfaces:** `RuntimeExecutionAdapter.executeRevision({jobId,candidate,revision,profile,plan,signal,onResource}): Promise<CheckObservation[]>`, where `revision:'base'|'head'`, `onResource(record:ResourceRecord): Promise<void>`. `executeCandidate({job,profile,adapter,signal,onResource}): Promise<CheckObservation[]>` invokes sequential base/head execution and retains every observation. `EvidenceWriter.write({jobId,checkId,commitSha,bytes,mediaType}): Promise<{artifactId:string,sha256:string}>` enforces owner/digest/size limits.

- [ ] Write `base_pass_head_runtime_fail`, `fixed_head_passes_original_and_independent_regression`, `removed_candidate_test_cannot_turn_verdict_green`, `preexisting_base_failure_is_disclosed`, `generated_test_runs_unchanged_on_both_revisions`, `wrong_test_content_digest_is_incomplete`, `truncated_or_unexecuted_output_is_not_success`, `candidate_cannot_receive_credentials`, `candidate_dependency_or_dockerfile_change_is_unsupported`, `credentialed_image_build_never_executes_candidate`.
- [ ] Run and confirm RED.
- [ ] Reuse hardened ECS lifecycle to start the actual Node app at exact base/head. Demo image/dependencies are prebuilt from trusted inputs; credentialed CodeBuild/ECR never runs candidate source, Dockerfiles, build scripts or npm hooks. Stage immutable source as data through trusted init with an expiring read-only download capability; validate digest and remove capability before app startup. Reject dependency/build changes as Incomplete. Record runtime image, source and dependency digests. Persist command/commit/test digest/expected/observed proof. Fixed assertions run outside the app; generated tests run from restored immutable artifacts in separate disposable credential-free compute with target-only access.
- [ ] Constrain networking at VPC/transport level, not prompt text. Omit application/generated-test task roles and credential mounts; execution role stays outside the task. Live probes cover application and generated-test metadata endpoints, environment, download-capability removal and absence of candidate execution in the credentialed builder. Arbitrary candidate builds remain blocked until the pilot implements a separate credential-free build executor and trusted publisher; path quoting alone is insufficient.
- [ ] Run adapter tests and existing AWS/network/cost tests; confirm GREEN. Endpoints or build resources missing return Incomplete, never fixture substitutes.
- [ ] Commit `feat: execute independent PR runtime checks`.

### Task 6: Enforce evidence verdicts and recover owned resources

**Files:** create `services/pr-verification/verdict.ts`, `recovery.ts`; modify controller; test `tests/pr-verification/verdict.test.ts`, `recovery.test.ts`.

**Interfaces:** `evaluateCandidate({candidate,plan,observations,cleanupComplete,superseded,evidenceManifestSha256}): PrVerificationResult`; `reconcilePrJobs({store,resourceAdapter}): Promise<{recovered:string[],blocked:string[]}>`. `ResourceAdapter.stop(record:ResourceRecord): Promise<'stopped'|'unknown'>`; `findOwned(runId:string): Promise<ResourceRecord[]>`. Unknown ownership must be preserved/blocked, never broad-pruned.

- [ ] Write `all_required_named_checks_must_execute`, `status_exit_mismatch_is_incomplete`, `missing_or_wrong_commit_artifact_is_incomplete`, `cleanup_unknown_blocks_verified`, `model_verdict_cannot_override_evidence`, `worker_death_triggers_owned_teardown`, `crash_before_id_response_recovers_by_run_tag`, `flaky_repeat_is_unknown`. Assert terminal success only after verified cleanup and exact evidence bindings.
- [ ] Run and confirm RED.
- [ ] Apply spec verdict precedence; reuse shared policy predicates where semantics match. Stop resources independently on success/failure/deadline/cancel; verify CodeBuild stop, ECS stopped state, AgentCore stop response/session identity. Persist cleanup errors and reserve the last 2 minutes; unfinished recovery blocks next admission. Add hard resource/time/tool count stops and report estimated versus observed costs.
- [ ] Run deterministic tests with controlled adapters; confirm GREEN. Test cleanup callbacks throwing and partial stop outcomes, not just success.
- [ ] Commit `feat: finalize PR evidence and reconcile cloud resources`.

### Task 7: Publish a current-head GitHub Check

**Files:** create `services/pr-verification/github-checks.ts`; modify `services/github-repair-transport.mjs`, `services/verified-repair-pr.mjs` to verify publication head; test `tests/pr-verification/github-checks.test.ts`, `tests-p1/m10-github-transport.test.mjs`.

**Interfaces:** `publishPrResult({job:PrJob,principal:RequestPrincipal,transport:GitHubTransport}): Promise<{checkRunId:number,commentId:number,published:boolean}>`. Use a trusted GitHub App installation token with contents/pull_requests read, checks write and pull_requests write for the evidence comment. Repair publication retains separate human authorization. `openPullRequest` transport accepts `expectedHeadSha:string`, validates returned `head.sha` and returns it.

- [ ] Write `check_is_on_expected_head_sha`, `head_changed_before_publish_does_not_success`, `base_changed_marks_superseded`, `base_advance_after_success_requires_updated_head_and_rerun`, `incomplete_and_unknown_map_to_action_required`, `retry_updates_same_check_and_comment`, `repair_pr_returned_head_mismatch_is_rejected`. Assert success only for exact revision/complete cleanup; no arbitrary source links in generated comments.
- [ ] Run and confirm RED.
- [ ] Create/update `VERIFAI / runtime` on actual head SHA with manifest/limitations; upsert one bounded comment. Re-fetch metadata before publication and persist superseded state. Require base ancestry and configure expected GitHub App plus strict up-to-date branch protection without bypass in acceptance. After base advances, update the branch and explicitly rerun. Without enforceable strict rules, publish advisory evidence only. Base-update automation and merge groups remain pilot scope.
- [ ] Run tests and verify actual GitHub App publication in Task 9. Check required-rule behavior for failure, action_required and base advancement after success; prove old green cannot authorize merging an outdated branch. Avoid an ambiguous neutral result.
- [ ] Commit `feat: publish commit-bound runtime verification checks`.

### Task 8: Expose the flow to coding agents and people

**Files:** create `scripts/verifai-pr.mjs`, `services/pr-verification/mcp.mjs`; modify `apps/web/index.html`; test `tests-p1/pr-agent-interface.test.mjs`, `tests-p1/pr-result-ui.test.mjs`.

**Interfaces:** CLI commands from the spec call the same authenticated HTTP endpoints; MCP tools `verify_pr`, `get_verification`, `cancel_verification` wrap those endpoints. Tokens come from backend/operator configuration; CLI output excludes credentials. Render actual `PrJob`/`PrVerificationResult`; no fabricated static Verified state.

- [ ] Write `cli_sends_expected_head_and_idempotency_key`, `mcp_cannot_submit_executed_evidence`, `agent_cannot_publish_repair`, `ui_shows_revision_required_coverage_and_cleanup`, `missing_artifact_is_visible`, `stale_result_cannot_show_current_success`. Assert wrong-owner artifacts are denied and sensitive headers are never rendered.
- [ ] Run and confirm RED.
- [ ] Add Start PR verification and a compact result view: Tested revision, Expected/Observed, required checks, failed reproduction, Unconfirmed hypotheses, evidence links, cleanup and limitations. Preserve existing warm light/orange design tokens; real browser coverage is visibly distinguished from fixture evidence. Keep human approval action separate.
- [ ] Run tests; manually verify desktop and narrow screen using real API states and installed Chrome. Do not require a fixture result to stand in for live acceptance.
- [ ] Commit `feat: connect agents and UI to PR verification`.

### Task 9: Prove the hackathon loop and measure limitations

**Files:** create `scripts/pr-runtime-acceptance.mjs`, `tests/pr-verification/acceptance.test.ts`, `docs/evidence/pr-runtime-acceptance.md`; update `docs/demo-script.md`, `docs/aws-runtime.md`.

**Interfaces:** `runPrRuntimeAcceptance({repository,bugPr,goodPr,fixedHead,outputDir}): Promise<{passed:boolean,runIds:string[],manifestPaths:string[]}>` uses the actual HTTP service, model/runtime/target/GitHub adapters. Required environment has explicit model ID/region/runtime ARN, installed App, approved budget and operator authorization. No fixture transport in this entrypoint.

- [ ] Write offline harness tests that acceptance refuses missing credentials/authorization, wrong revision, skipped required check, stale publication, reused target state and unproven cleanup. Confirm RED before implementing admission/manifest checks.
- [ ] Implement entrypoint and confirm harness GREEN. Pin a small real existing service repository and reproducible runtime regression; known bug revision and controlled failure tests are clearly labelled, separate from claims of autonomous new-bug discovery.
- [ ] On authorized AWS account, run base-pass/bug-head-fail → agent-produced fix → independent original/regression pass, plus unrelated good PR and unsupported repo. Preserve actual logs/check URLs/manifests and failed attempts. Record actual target/image identity and session/task/build terminal observations.
- [ ] Repeat three complete bad→fixed cycles with distinct jobs/fresh targets; exercise cancellation, worker death, stale head, removed tests, test-artifact tampering and base advancement after success. Verify strict branch rules prevent stale merging. Keep #11's ten-run local acceptance separately. A missing gate stops the release claim, not independent planning work.
- [ ] Run `npm run check` and `npm run ops:test` on final revision. Capture truthful agent→cloud execution→PR evidence recording. Document observed duration, flaky/false-success cases, scope and cost uncertainty; three cycles are smoke evidence, not a statistical safety guarantee.
- [ ] Commit evidence/runbook only after redacting and checking artifacts; open reviewed implementation PR(s), human merge only.

## Pilot work after the demo

### P1: Fully hosted durable controller and tenant access

Create `services/pr-verification/dynamodb-store.ts`, `queue.ts`, `auth.ts`, `artifacts.ts`, `infra/aws/pr-verification-control-plane.yml`; implement the Task 4 store interface with conditional writes, leases/heartbeats and idempotency. Use SQS for jobs and a separate durable resource reconciler. Store private immutable artifacts in S3 with 7-day initial TTL and owner-bound access. Enforce tenant/repository ownership, installation revocation and authenticated human approvals. Tests: duplicate deliveries; expired lease; replica crash; wrong tenant; artifact URL expiry; install removal; restore/recovery. Gate: kill/restart controller mid-run without lost history, cross-tenant access or orphaned resources. Add hosted health/alarms/rollback and account-wide quota reservation. This is the point at which the controller is fully cloud hosted.

### P2: Automatic intake, private/fork repos, merge safety and useful breadth

Before admitting dependency/build changes, implement a credential-free isolated candidate build executor plus separate trusted publisher. Probe metadata, hooks, builder privilege and artifact handoff before enabling it; the demo's trusted prebuilt dependency image is deliberately narrower.

Create signed webhook handler `services/pr-verification/github-webhooks.ts` with raw-body signature verification, event deduplication and repository-installation checks. Resolve fork head separately; private source staging never sends GitHub tokens to target/build. Cancel/supersede on synchronize/base changes; process merge-group SHAs for repos using merge queues. Add one actual cloned-app browser profile where appropriate, independent repair/regression transports and a second stack only after its own acceptance. Tests cover invalid signature, out-of-order/duplicate events, revoked installation, force pushes, base updates, forks and merge groups. Gate: required checks prove exactly the revision being merged and rerun without human babysitting.

### P3: Reproducibility, evaluation and operations

Commit reviewed dependency lockfile, pin worker/tool/base images by digest, enforce trusted profile versions and dependency provenance. Add `config/pr-evaluation-corpus.json` and `scripts/pr-verification-evaluate.mjs` for known regressions and clean PRs across profiles. Track observed false success, inconclusive rate, false alarms, reproducibility, time/cost to evidence and agent repair success; avoid a fake overall AI quality score. Do threat/security review of build networking, metadata/role access, generated-test tampering, artifact retention and installer hooks. Validate timeout/budget/cleanup under outages. Gate: publish dataset and counts with denominators and limits; choose acceptable thresholds with pilot users before marketing reduced risk quantitatively.

## Plan self-review and handoff

Spec coverage: safety/auth → Task 1; exact candidate → Task 2; trusted change-aware planning → Task 3; durable demo jobs/API → Task 4; runtime/dependencies/independent tests → Task 5; evidence/verdict/cleanup/budget → Task 6; GitHub commit binding → Task 7; agent/UI → Task 8; repeatable proof → Task 9; fully hosted/private/webhook/merge-queue/evaluation → P1–P3. Review Focus cases have named tests in their owning tasks.

The audit and plan do not authorize paid deployment, overwrite the local checkout or certify runtime parity. First implementation step is a small safety PR, then current live acceptance, followed by candidate identity. Approve or revise this proposed scope in the documentation PR before starting runtime implementation; choose native or supervised agent execution at that time. No additional agent framework or factory rewrite is needed for the demo.

## Primary technical references

- [Greptile TREX](https://www.greptile.com/trex): reference for runtime evidence on changed code.
- [GitHub App CI checks](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-ci-checks-with-a-github-app): check runs target a required `head_sha`.
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): strict checks require branches to be up to date before merging.
- [AgentCore StopRuntimeSession](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopRuntimeSession.html): explicit session lifecycle API.
- [ECS task IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [ECS IAM guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam-roles.html): separate application task permissions from execution/control permissions.
