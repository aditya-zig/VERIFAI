# VERIFAI local environment variables

Presence-only reference for the local-agent kit. **Never print or commit values.**
`local.env.example` holds placeholders only. Real values live in protected
`.env` files (gitignored) or exported shell variables.

## REQUIRED NOW

**M1 (local repository clone): none.** M1 requires no API key and no model
provider. `doctor.sh --stage M1` passes on a bare checkout.

**M2 (single API-backed analysis agent): exactly one configured API-backed
provider.** Default provider is `xkiro` (see `services/local-analysis.mjs`
`resolveModelConfig` on branch `m2-single-local-agent`):

| Variable | Purpose | Presence |
| --- | --- | --- |
| `XKIRO_API_KEY` | key for default provider `xkiro` | required when `VERIFIAI_MODEL_PROVIDER` is unset or `xkiro` |
| `VERIFIAI_MODEL_PROVIDER` | optional override: `xkiro` \| `openrouter` \| `nvidia` \| `ollama-cloud` | optional (defaults `xkiro`) |
| `VERIFIAI_MODEL_ID` | optional model override | optional (provider default otherwise) |

Key variable per provider: `xkiro` → `XKIRO_API_KEY`, `openrouter` →
`OPENROUTER_API_KEY`, `nvidia` → `NVIDIA_API_KEY`, `ollama-cloud` →
`OLLAMA_API_KEY` (an API service — **local Ollama is forbidden**).

## OPTIONAL LOCAL

| Variable | Purpose | Default |
| --- | --- | --- |
| `WEB_PORT` | web/UI port | `4173` |
| `WEB_HOST` | web bind address | `127.0.0.1` |
| `PORT` | legacy API port (apps/api) | `8787` |
| `VERIFIAI_WEB_URL` | web URL used by API | `http://localhost:4173` |
| `VERIFIAI_DATA_DIR` | API data directory | `./data` |
| `VERIFIAI_STATE_SECRET` | legacy API session state | — |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` | legacy OAuth | — |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | legacy OAuth | — |

Note: `start:api` (`apps/api`) hard-requires the OAuth block; the M2 local
flow (UI + clone + analyze on `4173`) does **not**.

## REQUIRED LATER

- M4+: Docker configuration (deferred; disk must be 20+ GB free first).
- Cloud/AWS variables: deferred behind the roadmap; do not configure now.

## LEGACY / DEPRECATED

- `VERIFIAI_MODEL_SECRET_ID` / `VERIFIAI_MODEL_SECRET_FIELD` — AWS Secrets
  Manager path; not used by the local M2 flow.
- `VERIFIAI_EXECUTION_MODE`, `VERIFIAI_LOCAL_WORKER_*`,
  `VERIFIAI_EXTERNAL_ENGINE_URL`, `VERIFIAI_BROWSER_USE_*`, `VERIFIAI_CUA_*` —
  external-engine/cloud-era settings; deferred with M4+/cloud work.
- `OLLAMA_API_KEY` here means the hosted `ollama.com` API only. **Installing
  or running local Ollama is forbidden.**

## Rules

- Check presence only: `VAR: present` / `VAR: absent`. Never echo values.
- Never commit `.env` (gitignored); commit only `local.env.example` placeholders.
- M2 uses API-backed models only, one heavy process at a time (8 GB laptop).
