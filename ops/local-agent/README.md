# VERIFAI local-agent kit

Purpose: make a fresh coding agent productive **without** relying on old chats or hidden machine knowledge.

Start with [`START-HERE.md`](START-HERE.md).

## Available now

| File | Purpose |
| --- | --- |
| [`START-HERE.md`](START-HERE.md) | shortest operating sequence for a new agent |
| [`CURRENT-STATE.md`](CURRENT-STATE.md) | snapshot-labeled stable context + live-check commands |
| [`AGENT-RULES.md`](AGENT-RULES.md) | non-negotiable operational rules |
| [`scripts/preflight.sh`](scripts/preflight.sh) | read-only machine/repo report (LA1) |
| [`scripts/check-docker.sh`](scripts/check-docker.sh) | read-only, label-scoped Docker inspection (LA1) |
| [`tests/kit-safety.test.mjs`](tests/kit-safety.test.mjs) | safety harness; run with `npm run ops:test` (LA1) |
| [`ENVIRONMENT.md`](ENVIRONMENT.md) | variable categories + provider/key rules (LA2) |
| [`env/local.env.example`](env/local.env.example) | placeholders only (LA2) |
| [`scripts/doctor.sh`](scripts/doctor.sh) | staged readiness: `--stage M1\|M2` (LA2) |
| [`scripts/start-local.sh`](scripts/start-local.sh) | starts owned services via repo npm scripts (LA3) |
| [`scripts/stop-local.sh`](scripts/stop-local.sh) | identity-verified stop of owned processes (LA3) |
| [`scripts/cleanup-local.sh`](scripts/cleanup-local.sh) | bounded cleanup of kit-owned resources (LA4) |
| [`scripts/verify-local.sh`](scripts/verify-local.sh) | honest per-check verify runner (LA5) |
| [`VERIFY.md`](VERIFY.md) | what verify runs + PASS/FAIL/SKIPPED meanings (LA5) |
| [`WORKFLOW.md`](WORKFLOW.md) | issue → RED → GREEN → verify → PR sequence (LA5) |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | known failures + stop rule (LA5) |
| [`SETUP.md`](SETUP.md) | machine/repo bootstrap (LA5) |
| [`DOCKER.md`](DOCKER.md) | M4 Docker bounds, inspect-only until then (LA5) |
| [`HANDOFF-TEMPLATE.md`](HANDOFF-TEMPLATE.md) | reproducible handoff template (LA5) |

## Planned (NOT IMPLEMENTED YET)

Live verification runs against the kit (LA6) are a manual step, not
kit files. **Do not invent scripts beyond the index above and do not
create placeholder files.**

Core rule: GitHub + the current checkout outrank memory and old chats. See [`START-HERE.md`](START-HERE.md).
