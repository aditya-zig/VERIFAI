# Bedrock model settings

Supported provider: Amazon Bedrock. Both bounded source reviewers use the Strands
Agents SDK with BedrockModel, one model turn, no provider fallback, no agent retry,
and AWS SDK maxAttempts=1. The AWS SDK owns credentials; no API key is serialized
into run metadata. The selected model identity is recorded as requested identity;
reported model, HTTP status and response ID remain Unknown when not supplied.

Set `AWS_REGION` (or `AWS_DEFAULT_REGION`) and `VERIFIAI_BEDROCK_MODEL_ID`
(or `VERIFIAI_MODEL_ID`) in the backend environment. Use your AWS CLI/SSO profile
locally and the execution IAM role in AgentCore. `config/local-models.env.example`
lists the supported names. Never commit or publish credentials.

`config/local-models.json` uses schemaVersion 2, timeoutMs (1–60000) and maxTokens
(1–500). Optional `region` and `modelId` may be set there. Environment selection
wins. A custom file is selected by `VERIFIAI_MODEL_CONFIG`, is a regular file,
and is limited to 64 KiB. Version-1 external provider/route catalogs are rejected.
`VERIFIAI_MODEL_BASE_URL` and `VERIFIAI_AGENT_HARNESS` are retired.

Source context stays bounded to 12 files, 4000 characters per file, and 12000
characters total. JSON parsing, severity normalization, tracked-file citation
admission and executed-evidence semantics are unchanged. A source observation
remains Unconfirmed; a configured AWS model is not live acceptance proof.

See [AWS runtime setup](aws-runtime.md). No AWS calls occur in offline unit tests.
