# VERIFAI local environment variables

Presence-only reference for the local-agent kit. **Never print or commit values.**
`local.env.example` holds placeholders only. Real values live in protected
`.env` files (gitignored) or exported shell variables. Scripts do not load the
example automatically; export the required variables before starting the API.

## REQUIRED NOW

**M1 (local repository clone): none.** M1 requires no AWS credentials or model
provider. `doctor.sh --stage M1` checks local prerequisites only.

**Analysis: AWS Bedrock through Strands.** The AWS-only direction in #74
supersedes the earlier deferred cloud guidance. AgentCore workers use their
execution IAM role; local analysis uses the standard AWS credential chain.

| Variable | Purpose | Presence |
| --- | --- | --- |
| `VERIFIAI_MODEL_PROVIDER` | supported provider: `bedrock` | optional (defaults to `bedrock`) |
| `VERIFIAI_BEDROCK_MODEL_ID` | Bedrock model or inference profile ID | required, or use `VERIFIAI_MODEL_ID` |
| `VERIFIAI_MODEL_ID` | fallback model/inference profile ID | required when Bedrock-specific ID is unset |
| `AWS_REGION` | AWS region for the configured model | required, or use `AWS_DEFAULT_REGION` |
| `AWS_DEFAULT_REGION` | fallback region | required when `AWS_REGION` is unset |
| `AWS_PROFILE` | local AWS profile, including SSO | use a configured profile or another AWS credential-chain source |
| `AWS_SHARED_CREDENTIALS_FILE` / `AWS_CONFIG_FILE` | optional shared AWS file locations | optional with profiles; default `~/.aws/credentials` and `~/.aws/config` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | temporary environment credentials | access-key pair required for this source; session token required for temporary credentials |
| `AWS_BEARER_TOKEN_BEDROCK` | supported Bedrock bearer credential | alternative credential source |

Use a configured local profile/SSO session or temporary AWS credentials.
In AgentCore, grant the execution IAM role permission to invoke the configured
Bedrock model/inference profile. AWS container and web-identity role sources
also follow the standard SDK chain. Do not supply third-party model API keys.

Run `./ops/local-agent/scripts/doctor.sh --stage M2` after exporting configuration.
Doctor checks presence only, never credential validity, live access, model
availability, IAM permissions, or SSO expiry. A presence PASS is not live proof.

## OPTIONAL LOCAL

| Variable | Purpose | Default |
| --- | --- | --- |
| `WEB_PORT` | web/UI port | `4173` |
| `WEB_HOST` | web bind address | `127.0.0.1` |
| `PORT` | local API port | `8787` |
| `VERIFIAI_WEB_URL` | web URL used by API | `http://localhost:4173` |
| `VERIFIAI_DATA_DIR` | API data directory | `./data` |
| `VERIFIAI_RUN_AWS_E2E` | explicit live Bedrock E2E opt-in | unset; only `1` opts in |

Keep AWS credentials in the API/backend environment. The startup script gives
the web proxy and browser children a clean environment. Local startup does not
require OAuth application credentials.

## REQUIRED LATER

- A live AWS acceptance run needs an authorized account, valid credentials,
  model access, IAM permission, the model ID, and region. Set
  `VERIFIAI_RUN_AWS_E2E=1` only for an explicitly authorized live run; requests
  can incur AWS charges. Ordinary CI runs the structural E2E lane without opting in.
- AgentCore deployment needs its execution-role policy and deployment settings.
  Configuring local Bedrock analysis does not deploy infrastructure.
- Bounded local Docker command verification needs the documented image and
  sufficient disk; see [`DOCKER.md`](DOCKER.md).

## LEGACY / DEPRECATED

Third-party model keys and provider selection are unsupported. Historical
OAuth/cloud documentation is not a requirement for the local startup flow.

## Rules

- Check presence only: `VAR: present` / `VAR: absent`. Never echo values.
- Never commit `.env` (gitignored); commit only `local.env.example` placeholders.
- API-backed models only; no Ollama. One heavy process at a time (8 GB laptop).
- Missing AWS/model capability means Incomplete/Unknown, never a fabricated PASS.
