# Environment

Never commit real secrets. Prefer exported shell variables or a private local `.env` that is excluded from Git.

## Required now

For the M1 public-repository clone path, no model or OAuth secret is required.

For M2, one existing API-backed provider is required:

```text
VERIFIAI_MODEL_PROVIDER=openrouter | nvidia
VERIFIAI_MODEL_ID=<provider model id>
OPENROUTER_API_KEY=<required when provider=openrouter>
NVIDIA_API_KEY=<required when provider=nvidia>
```

`VERIFIAI_MODEL_BASE_URL` is an optional provider endpoint override. Do not configure Ollama for the local-first roadmap.

## Optional/current local configuration

```text
PORT
VERIFIAI_WEB_URL
VERIFIAI_SECURE_COOKIES
VERIFIAI_DATA_DIR
AWS_REGION
```

## Required only for legacy/auth flows

These exist in the current repository but are not required by the M1 no-auth local path:

```text
VERIFIAI_STATE_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_CALLBACK_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL
```

## Required later / deferred

External-engine, Cua, Browser Use, MiroFish, Strix, AgentCore, ECS and other cloud/runtime variables remain deferred until their roadmap stages. Re-read `.env.example` at that time instead of copying old values from this file.

## Legacy/deprecated for this local-first phase

- `OLLAMA_API_KEY` / `ollama-cloud`: present in older provider code, but prohibited by the current project rule.
- TrueForge-specific variables: deferred.
- AWS AgentCore runtime variables: deferred.

`env/local.env.example` intentionally contains placeholders only.
