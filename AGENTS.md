# VERIFAI — coding-agent entry point

VERIFAI uses **Strands Agents SDK + Amazon Bedrock AgentCore Runtime + Amazon Bedrock**.
Issue #74 records the AWS-only runtime decision (3 October 2026).

**Fresh agents MUST read [`ops/local-agent/START-HERE.md`](ops/local-agent/START-HERE.md) before starting any task.**

Operating rules:

- GitHub is the implementation source of truth. Current issue/PR/CI state must be checked live — never from memory or an old chat.
- Work one issue at a time: issue → branch → RED → smallest GREEN → verification → PR.
- Evidence over AI opinion. Missing capability = Incomplete/Unknown; never invent PASS.
- Factory/repair progression is enforced by code, not prompt compliance. Read `docs/factory-gates.md`; do not bypass the shared verification policy or its evidence-bound approval.
- Humans approve merges. Never auto-merge.
- Use Bedrock with the AWS credential chain; AgentCore workers use an execution IAM role.
- Deployment, paid live smoke tests, and resource creation need an explicit assigned task.
- No local Ollama or unrelated software-factory work.
- Development machine has 8 GB RAM: API-backed models only, one heavy process at a time.

Kit index: [`ops/local-agent/README.md`](ops/local-agent/README.md). Historical evidence remains as history. Current AWS setup: `docs/aws-runtime.md`.
