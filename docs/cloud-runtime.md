# VERIFAI cloud runtime (M12 #18)

Status: **IMPLEMENTED — REAL AWS SMOKE PENDING**

Reference behavior is PR #60 head `86557a45636fd7e2a1965113cb60883173b5f3f0`. Cloud changes where bounded work runs; it does not redefine VERIFAI stages, evidence, repair gates, approval, artifacts, or terminal-state truth.

## Architecture

Control plane -> one ECS/Fargate task -> exact public GitHub commit -> one model-backed review -> one bounded command -> M9-compatible artifacts in private S3 -> structured CloudWatch logs -> task exits.

There is no ECS service, worker fleet, NAT Gateway, EKS, RDS, Redis, Kafka, OpenSearch, Step Functions graph, autoscaling layer, GPU, Docker socket, or nested Docker.

The Fargate task itself is the bounded execution sandbox. The current safe command policy remains limited to the existing node version/check or tracked README check. A nonzero command is real executed failure evidence and the run remains Incomplete, matching local semantics.

## Required environment variable names

Deployment/control plane:

- AWS_REGION
- VERIFIAI_CLOUD_ALLOW_PROVISION
- VERIFIAI_CLOUD_STACK_NAME
- VERIFIAI_CLOUD_ENVIRONMENT
- VERIFIAI_CLOUD_WORKER_IMAGE_URI
- VERIFIAI_CLOUD_WORKER_REPOSITORY_ARN
- VERIFIAI_CLOUD_PROVIDER_SECRET_ARN
- VERIFIAI_CLOUD_PUBLIC_SUBNETS
- VERIFIAI_CLOUD_SECURITY_GROUPS
- VERIFIAI_CLOUD_DEADLINE_MS
- VERIFIAI_CLOUD_ESTIMATED_SPEND_USD
- VERIFIAI_SMOKE_REPOSITORY_FULL_NAME
- VERIFIAI_SMOKE_REPOSITORY_URL
- VERIFIAI_SMOKE_REPOSITORY_COMMIT
- VERIFIAI_MODEL_PROVIDER
- VERIFIAI_MODEL_ID

Task-only values are injected by the stack/control plane. Raw provider secrets are never accepted in the job payload.

## AWS resources

`infra/aws/runtime-cloudformation.json` creates only:

- private S3 artifact/run-state bucket with full public-access block and bounded lifecycle
- ECS cluster
- 0.5 vCPU / 1 GiB Fargate task definition
- CloudWatch log group
- separate task-execution and task roles
- an unattached least-privilege control-plane managed policy

Public subnets are supplied by the operator and the task receives a public IP for outbound GitHub/model access. This avoids a NAT Gateway for the development smoke. The security group should allow outbound HTTPS and require no inbound rule.

## Cost and runaway controls

Default software bounds:

- one task
- <= 20 minutes
- <= 4 model calls; smoke uses one
- <= one retry
- configured estimated-spend ceiling
- S3 retention default 7 days
- CloudWatch retention 7 days

A budget violation returns `Incomplete / BudgetLimit` before ECS RunTask.

## Idempotency and recovery

S3 conditional create owns `runs/<runId>/control/lock.json`. ECS also receives a deterministic client token. Re-submitting the same run ID returns the existing state instead of intentionally launching another worker.

If the client disconnects, call refresh/get with the same run ID. A stopped task with no terminal result maps to `Incomplete / WorkerStoppedWithoutResult`.

## Cancellation and stale cleanup

Cancellation first proves exact ECS task tags:

- project=verifiai
- runId=<id>
- environment=<env>

Only then is StopTask called. Existing S3 artifacts are preserved.

The stale reaper uses the same ownership proof. There is no global prune.

## Artifacts

Cloud uses the M9 bundle generator. Keys are bounded to:

    runs/<run-id>/manifest.json
    runs/<run-id>/run.json
    runs/<run-id>/repo.json
    runs/<run-id>/execution.json
    runs/<run-id>/stdout.txt
    runs/<run-id>/stderr.txt
    runs/<run-id>/...

Objects are private, server-side encrypted, size bounded, and secret-redacted before upload. Retrieval should be API-mediated or short-lived signed access; public bucket/object access is prohibited.

## Logging

The worker emits JSON events with runId, stage, timestamp, status, duration, task ARN when available, model/provider names, artifact refs and cleanup. Secret values are not logged.

## Static verification

Run:

    npm install --package-lock-only --ignore-scripts --no-audit --no-fund
    npm ci --ignore-scripts --no-audit --no-fund
    npm run cloud:preflight
    npm run cloud:test-contract
    npm run cloud:worker:self-check
    docker build -f infra/aws/runtime-worker.Dockerfile -t verifiai-runtime:$(git rev-parse HEAD) .

CI additionally runs cfn-lint and records the generated dependency lockfile plus base-image digest as build evidence.

## Deployment and smoke

Real provisioning is blocked unless `VERIFIAI_CLOUD_ALLOW_PROVISION=true`.

Before the first real smoke:

1. Build the worker from `infra/aws/runtime-worker.Dockerfile` with the generated package-lock.
2. Push it to ECR with an immutable git-SHA tag; set its exact image URI and repository ARN.
3. Use an existing public subnet and outbound-only security group.
4. Put the model provider key in Secrets Manager and supply only its ARN.
5. Set an exact small public repository commit.
6. Run `npm run cloud:deploy-smoke`.

Acceptance is only real when the terminal result proves: exact repo/commit -> real model call -> bounded command -> evidence/finding -> M9 artifact -> cleanup.

## Teardown

Run:

    npm run cloud:teardown

Teardown refuses while the runtime cluster still has a running task. It empties only the stack-owned artifact bucket, deletes only the named smoke stack, and waits for stack deletion.

## Failure recovery

- Invalid repo/commit: fix exact identity and use a new run ID.
- Provider missing/timeout: result stays Incomplete; fix secret/provider and use a new run ID.
- Task launch failure: no infinite retry; inspect ECS error and retry explicitly if safe.
- Artifact upload failure: preserve logs/state; do not relabel as Completed.
- Cancellation timeout/cleanup failure: inspect the exact task ARN and ownership tags before any manual stop.
- Stale task: invoke the bounded reaper for that run only.

To verify zero lingering resources after teardown, confirm the named CloudFormation stack is deleted, the cluster no longer exists, the stack-owned bucket is gone, and there are no exact-run task ARNs recorded as running.

## Supply chain

- Base image: node:22.20.0-bookworm-slim
- Runtime: Node 22.20.0
- Worker image tag: immutable git SHA; never latest
- Build commit: the git SHA used as the image tag
- Dependency lock: package-lock.json is generated before the build and archived by cloud static CI
- Base-image digest: cloud static CI records the pulled RepoDigest when available

The real pushed ECR image digest remains runtime proof and is not claimed by static preparation.
