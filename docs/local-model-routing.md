# Swapping hosted models and providers

The local base analysis and opt-in security source review share one routing module.
**Edit `config/local-models.json`; the next review reads the saved configuration.**
No UI rebuild, SDK dependency or source-code edit is needed for another compatible model/provider.
Changes affect the next review, not an already-started route chain.

## Keys stay separate

From the checkout:

```sh
cp config/local-models.env.example .env.local
chmod 600 .env.local
# Fill only the needed values locally in your editor, then run:
./start.sh
```

Do not overwrite an existing private file. `.env.local` is ignored by Git;
never add it forcibly or paste its contents into reports. Only the API entry
point loads it, before importing its modules. The clean-environment web proxy
and browser children do not load it. Existing launching environment variables
win over values in the file. Restart the backend after changing keys; JSON
route edits are read on the next analysis without a restart.

Each provider references its own environment variable through `apiKeyEnv`.
Missing keys skip routes; another provider's key is never implicitly reused.
Key values do not belong in JSON, URLs, prompts, browser code or Git.
A fresh GitHub checkout needs its own private credentials; they are not shipped.

## The default order

1. `xkiro` / `qwen/qwen3.8-max:free`
2. `xkiro` / `qwen/qwen3-coder-plus:free`
3. `token_harbor` / `deepseek-v4-flash:free`

Qwen Coder Plus is a model-specific alternative, not an xkiro-outage backup.
Authentication/quota failures, network/attempt timeouts and common gateway
outages skip remaining models on that provider. Model-specific HTTP errors,
unapproved identity and invalid findings can try the next model there.
There are no automatic retries, sleeps or paid-route substitutions.

The shortlist passed three clarified synthetic checks per route, not a general
intelligence or uptime benchmark. Its 30:50:20 speed/correctness/sample-availability
policy is provisional. Real local audits are separate acceptance evidence.
Prices, quotas and access can change: verify current provider terms before use.
Token Harbor's free-route policy may retain/analyze prompts after opt-in; use
it only if that policy is acceptable, and disable its route otherwise. We do
not change consent/account settings. Different gateways may share upstreams.
NVIDIA, OpenRouter and Seek trial entries remain disabled; a catalog listing
alone is not acceptance. NVIDIA hosted no-cost access is development/evaluation,
not an unconditional production allowance. Seek's unexplained MiniMax substitution
is not accepted as GLM.

## Add any compatible hosted provider/model

This module speaks hosted **OpenAI-compatible `/chat/completions`**, with a
text `choices[0].message.content` response. It is not a native Anthropic/Gemini,
AWS-signing or arbitrary inference-protocol adapter. No local model is installed.

Add a provider to `providers`:

```json
{
  "id": "my_provider",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "MY_PROVIDER_KEY"
}
```

Add its key to the private backend environment, and insert an enabled route at
the desired position in `routes`:

```json
{
  "id": "my_primary",
  "provider": "my_provider",
  "model": "vendor/model-id",
  "enabled": true,
  "reportedModels": ["vendor/canonical-model-id"],
  "jsonMode": true,
  "parameters": { "temperature": 0.2 }
}
```

The requested ID is automatically approved. `reportedModels` lists only vetted
canonical aliases; it is optional. Missing/unapproved reported identities fail
closed, even if the response is valid JSON. Never use an alias to excuse an
unexplained different-model substitution. Seek GLM keeps its stricter historical
identity guard. Reported identity is gateway metadata, not weight attestation.

Providers default to `authorization: Bearer <key>`. For compatible token-header
APIs, optional `authHeader` selects a lowercase header name and `authScheme`
selects `Bearer`, `Token`, `Basic` or an empty string. For a literal API-key
header use `"authHeader": "api-key", "authScheme": ""`. Reserved transport,
cookie and routing headers cannot be overridden. Basic credentials, if used,
must already be encoded in the referenced private variable.

Use the final HTTPS base URL: credentials/query/fragment and redirects are
rejected. `jsonMode: false` omits JSON response format for a model that cannot
accept it; its content still must normalize into a valid finding referencing a
tracked file. Optional bounded parameters are `temperature`, `top_p`,
`reasoning_effort`, `reasoning` (`enabled`, `effort`) and boolean
`chat_template_kwargs` (`enable_thinking`, `low_effort`, `clear_thinking`,
`force_nonempty_content`). Arbitrary request bodies, token caps and headers
cannot be smuggled through parameters.

## Bounds, selection and evidence

Defaults: 60-second routing budget, 20 seconds per attempt, at most three API
attempts. Configuration cannot raise the budget above 60 seconds or the attempt
cap above five. Calls are sequential; cancellation stops the chain. Late replies
are not accepted merely because a timer callback was delayed. Requests retain
a 500-token output cap and a 1 MiB body limit; configuration is limited to 64 KiB,
32 providers and 32 routes. Invalid schema or credential-containing configuration
fails before any model request. Model metadata, findings and errors must not publish
configured credentials. Exhaustion yields Incomplete, never a substitute finding.

- `VERIFIAI_MODEL_CONFIG` selects a custom JSON file (relative to launching cwd,
  or absolute) and takes precedence over legacy model selectors.
- Without a custom file, explicit `VERIFIAI_MODEL_PROVIDER`, `VERIFIAI_MODEL_ID`
  or `VERIFIAI_MODEL_BASE_URL` preserves one-provider/one-attempt behavior.
  The historical xkiro default for that compatibility seam is Ministral 8B,
  not the new automatic chain. HTTPS/key-disclosure guards still apply.
- Without those selectors, analysis and security use the default JSON chain.

`run.model` records the winning provider, requested and reported model, route,
actual base API-attempt `calls` and sanitized `attempts` (outcome, duration and
known HTTP status). Failed analysis preserves attempt provenance without a
winning model. An opt-in security review has its own `results[].model` trace.
`specialists.modelCalls` is the historical admitted-review lease counter;
`specialists.apiAttempts` counts physical API attempts across those callbacks,
or is null when a callback does not supply trustworthy counts. Failed reviews
retain their sanitized model trace. Neither counter is proof of correctness.

The audit still executes only server-owned bounded commands. A model finding
remains **Unconfirmed**. A successful README tracking command is not a passing
test suite or security verification. See [acceptance evidence](evidence/model-routing.md).

## Deterministic checks

```sh
node --test tests-p1/model-routing.test.mjs tests-p1/model-config.test.mjs
npm run check
npm run ops:test
./ops/local-agent/scripts/verify-local.sh
```

These tests mock only HTTP/repository fixture seams and are not real-provider
acceptance. The real browser/Docker/API test is development-only and requires
installed Chrome, the existing owned sandbox image and private API access:

```sh
VERIFIAI_MASTER_URL=http://127.0.0.1:4173 node --test tests-e2e/local-audit.test.mjs
```

No native-protocol adapters, cloud provisioning, Docker installation/build,
local model downloads or automatic PR merge are added by this change.
