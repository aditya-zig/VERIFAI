# AWS-only VERIFAI runtime

Decision: 3 October 2026, issue #74. The supported agent stack is Strands Agents
SDK for orchestration, Amazon Bedrock for model inference, and Amazon Bedrock
AgentCore Runtime for isolated workers. The unmerged replacement-harness stack
is retired. Its Fargate draft is historical preparation, not the runtime baseline.

## Paths

- Local development: lightweight UI/API → bounded Strands Bedrock source review
  → one bounded Docker command → evidence/finding/proof → cleanup. No model runs
  on the 8 GB laptop. One heavy process at a time.
- AWS workers: existing audit API → Strands planner on Bedrock → AgentCore worker
  sessions → scoped tools → structured evidence/report → StopRuntimeSession.
  The current worker contract and evidence/repair/human PR gates stay in force.

The local UI does not automatically deploy or launch AgentCore. The existing
cloud API owns worker orchestration. Optional specialist tools remain unavailable
unless their real transports are configured; they must return Incomplete, never
invent security, browser, performance, repair or cleanup evidence.

## Configure

Set the backend variables in `.env.example` or protected ignored `.env.local`:

- `AWS_REGION` / `AWS_DEFAULT_REGION`: region where the chosen model is accessible.
- `VERIFIAI_BEDROCK_MODEL_ID` / `VERIFIAI_MODEL_ID`: explicit Bedrock model ID or
  inference-profile ID/ARN; there is no silent model default.
- `VERIFIAI_EXECUTION_MODE=agentcore` and `VERIFIAI_AGENTCORE_RUNTIME_ARN`: existing
  deployed worker ARN for the AWS audit API.
- The smoke script uses the same Bedrock model ID and region variables.

Authenticate local development through the AWS credential chain (profile/SSO
or temporary env credentials). AgentCore uses its execution IAM role. No external
model key or model-secret ARN is needed. Scope runtime model permissions to the
chosen Bedrock model/inference-profile ARNs. Cross-region inference profiles also
need the underlying destination model ARNs authorized. Network access must reach
Bedrock Runtime and required tool endpoints; VPC mode needs private endpoints or
approved egress. A hostname allowlist is not a configured VPC network.

## Verification

`npm run check` and `npm run ops:test` are offline contract/regression checks.
Normal CI skips live AWS model tests. An explicit `VERIFIAI_RUN_AWS_E2E=1` plus
model/region configuration enables the CI provider lane. Run only with authorized
credentials and budget. `npm run verify:agentcore` exercises an already-deployed
runtime and verifies status/report/teardown events. It is not full product parity.

AWS deployment and full model-backed local/AgentCore acceptance remain pending
until real account access, model entitlement, runtime ARN and cleanup evidence are
available. No resources or spending are claimed by this migration PR.
