# Local MVP: one bounded audit

Linux, Node 22+, installed npm dependencies, Docker CLI/daemon access, and one
API-backed model configuration are prerequisites. Acceptance also requires an
already-installed Chrome (`VERIFIAI_CHROME` may identify its executable).
Do not download a browser, start Ollama, start cloud/TrueForge/engine stacks,
or prune unrelated resources to make tests pass.

The tested target is https://github.com/octocat/Hello-World, a tiny public
repository. Its tracked README check is a permitted limited evidence check,
**not its test suite**. Small Node repos support only exact `node --version`
scripts or `node --check <tracked JS file>`. Arbitrary npm hooks, dependencies,
model-generated shell, installs and unsupported commands are not executed.

## Configuration (names only)

Edit `config/local-models.json` for the ordered hosted provider/model list.
Defaults: xkiro Qwen3.8 Max free → xkiro Qwen Coder Plus free → Token Harbor
DeepSeek V4 Flash free. Supply each provider's referenced key in the backend
launching environment or protected, ignored `.env.local` (API role only).
See [swapping models/providers, bounds and privacy](local-model-routing.md).
Explicit `VERIFIAI_MODEL_PROVIDER`, `VERIFIAI_MODEL_ID`, `VERIFIAI_MODEL_BASE_URL`
retain the legacy single-provider behavior when no custom JSON path is set;
its historical xkiro default remains `mistralai/ministral-8b`. Never commit,
paste into logs or send keys to a container/browser. No key value belongs here.

Seek AI uses `VERIFIAI_MODEL_PROVIDER=seek_ai`, an explicit
`VERIFIAI_MODEL_ID` (for example `glm-5.3-flash` when listed by the provider), and
`SEEK_AI_API_KEY` in the backend environment. Its default API base URL is
`https://seekai.cc/v1`; this labels findings as Seek AI rather than xkiro.
Configuration support is not proof of model compatibility: a real
`jonschlinkert/is-number` trial returned invalid JSON at the existing 500-token
cap, and a second trial at 1500 tokens hit the 60-second model timeout. Both
ended Incomplete with cleanup completed; the speculative cap increase was not
retained. Provider-specific GLM response/reasoning compatibility remains unverified.
A subsequent tiny JSON diagnostic with documented `reasoning_effort: low`
reported `MiniMaxAI/MiniMax-M2.7`, not the requested GLM, and included inline
reasoning instead of pure JSON. The Seek AI GLM path now fails closed if the
response omits or differs from the requested model identity (case-insensitive).
Do not silently accept another model or strip reasoning to label it GLM.
Seek AI's routing/model mapping must be corrected before real GLM acceptance
can be retried. See `docs/evidence/seek-ai-glm53-trial.md`.

## Prepare once, then start

Run from the checkout. With >=20 GiB free and Docker ready:

```sh
./ops/local-agent/scripts/preflight.sh
./ops/local-agent/scripts/check-docker.sh
./ops/local-agent/scripts/build-sandbox.sh
./start.sh
```

`npm start` is the same launcher. You can also invoke `/path/to/VERIFAI/start.sh`
from outside the checkout; it selects its own repository directory. The existing
`ops/local-agent/scripts/start-local.sh` command remains supported. The launcher
inherits backend environment values; the API role additionally loads optional
`.env.local`, without overriding existing values. The web proxy never loads it.
The launcher does not install packages, start an audit or restart an already-running
service. JSON routes reload per review; restart safely after backend code/key changes. Restart clears in-memory audit history.

Start launches only the existing lightweight web/API roles, using ports **4173**
and **8787**, each with a 256 MiB Node old-space heap cap. The local API replaces the old
OAuth/cloud API role; it does not start additional workers/engines. Existing port
occupants are never killed. No model runs locally. The web proxies local routes
to the API. Docker starts only for a selected command, not at idle.

Open http://127.0.0.1:4173, paste the target URL, click Start local check. Actual
stages: clone → analysis → sandbox → execution → finding → cleanup. The model
reviews bounded real source context once before execution. The server attaches
actual command output/exit/duration to that finding afterward; it does **not**
claim the model predicted/interpreted future output. Optional sequential security
source review, a local fixture browser journey, repair replay, proof downloads and
explicit human PR creation are separately gated. The browser journey tests the
fixture, not the cloned application. Repair reruns the same bounded command; it
is not independent regression coverage. No automatic merge or video evidence is
provided. See the [evidence ownership glossary](../CONTEXT.md).

Each API call carries a unique audit identity/no-cache request. Response identity
and token usage, where provided, are recorded for traceability. Execution is
always real, never cached. Model severity is an opinion, not a verified verdict.

## Verify

```sh
npm run test:local-e2e
npm run typecheck
npm run ops:test
npm run check
```

The local suite uses real public clones, the configured API model, a real Docker
image, real command output, a real installed browser, and actual filesystem/
Docker cleanup checks. Missing credentials/image/daemon/browser fail or return
Incomplete, never a manufactured PASS. Failure/timeout programs are explicit
local negative-test fixtures, not substitutes for master execution evidence.

For ten sequential browser-driven runs through the live web AND API:

```sh
VERIFIAI_MASTER_URL=http://127.0.0.1:4173 \
VERIFIAI_MASTER_RUNS=10 \
VERIFIAI_MASTER_LOG=docs/evidence/m5-runs.json \
VERIFIAI_MASTER_SCREENSHOT=docs/evidence/m5-master.png \
node --test tests-e2e/local-audit.test.mjs
```

Every run checks Busy for a simultaneous request, all real stage results, captured
output hash, actual Docker limits/removal, automatic clone deletion, rendered
finding/evidence, and both health endpoints. JSON logs include failures, not just
successes. A failed full run stops the loop; diagnose it instead of skipping it.

## Bounded lifecycle

One audit admitted at a time, one logical base review (up to three configured
API attempts by default), one 1 GiB / 2 CPU nonprivileged,
non-root, network-none container. No host bind/socket mounts or credentials.
A copied clone lives in a disposable writable layer (Docker Desktop cannot copy
into a read-only rootfs). Output <=8 KiB/stream; command default 10 s; model 60 s;
clone 119 s; whole master deadline 120 s with cancellation and cleanup.

All target workspaces are registered BEFORE creation beneath the checkout-owned
kit state root. SIGTERM/SIGINT stop active work and clean repositories/containers.
On restart, dead PID/start-identity workspaces and kind-labelled audit containers
are recovered. Live owners and unverified ownership are preserved/refused.
Run records are bounded in-memory (30); restart loses UI history, not ownership
records needed for recovery. Cleanup errors prevent a Completed result.

Safe stop (do not kill random port occupants):

```sh
./ops/local-agent/scripts/stop-local.sh
```

For no-leftover checks use `check-docker.sh` and the owner-labelled containers;
never broad Docker prune, `/tmp` deletion, or application-data cleanup.

## Known limits

Only small public repositories and the narrow supported check policy are suitable.
No dependency installation, full app execution, cloned-application browser journey
or complete test coverage. Git clone/context/model run in the backend; only the selected command
runs in Docker. Network or provider availability can make a run Incomplete. A
completed README/runtime check is not proof of security, test-suite correctness,
or patch readiness. The model hypothesis remains Unconfirmed even after a
successful check or repair replay. Only an admitted failed executed check can
enter repair, and only VerifiedRepair can offer the explicit PR action. Terminal
proof bytes and manifests are stable and tamper-checked; Missing evidence remains
explicit. Humans merge the stacked PRs. The locally verified integration is not
permission to merge upstream PR #66 as-is or start deferred cloud stacks.
