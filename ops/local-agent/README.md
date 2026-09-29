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

## Planned (NOT IMPLEMENTED YET)

The following parts are planned for later LA slices. **None of them exist yet — do not invent them and do not create placeholder files:**

- setup — machine/repo bootstrap
- environment — current vs deferred env vars
- doctor — bounded diagnostics
- start/stop — process lifecycle
- verification — evidence collection
- Docker guidance (M4+)
- cleanup — kit-owned resource cleanup
- handoff — reproducible handoff template

Core rule: GitHub + the current checkout outrank memory and old chats. See [`START-HERE.md`](START-HERE.md).
