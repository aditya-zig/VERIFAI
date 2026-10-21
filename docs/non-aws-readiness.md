# Non-AWS readiness and runbook

Baseline snapshot of main `b88775d`, the merge of PR #79. The isolated
documentation worker recorded these observations on 21 October 2026 before
the non-AWS integration changes. They are not acceptance evidence for the
release branch. Check GitHub for current issues, PRs and CI.

The `AgentCore live acceptance` workflow requires explicit dispatch and
repository secrets. It remains outside this work. The evidence section below
separates commands that the documentation worker ran from source descriptions.

## What main currently is, without live AWS

- `start.sh` launches the kit web role on port 4173 and the local API on port
  8787, both with a 256 MiB Node old-space cap. Occupied ports are refused,
  never killed. The web proxy starts with a clean environment; only the API
  role loads `.env.local`. Restart clears in-memory audit history.
  The non-AWS integration launcher also compiles TypeScript before starting
  either role. Help and invalid arguments do not compile or start services.
- An audit runs clone, Bedrock-backed analysis through Strands
  (`@strands-agents/sdk`), then one bounded Docker command execution, a
  finding with recorded output, and cleanup. A missing model, denied access,
  invalid output, or credentials failure returns Incomplete. Nothing fabricates
  a PASS; see `CONTEXT.md` for the Incomplete, Unconfirmed, and Unknown terms.
- Enforced by code on this merge: executed-evidence consistency before a
  finding completes, including cleanup proof (`PR #79`), dense verification
  evidence (`e372546`), and the deterministic repair and PR-approval gates in
  `docs/factory-gates.md`, implemented by `services/repair-verification-policy.mjs`.
- Model routing has no silent default and no provider fallback: Bedrock with
  `config/local-models.json` caps (60 second model deadline, 500 token cap,
  bounded attempts per review). External catalogs, endpoint overrides, and
  harness selection are rejected (`docs/local-model-routing.md`).

## Startup, reproducible

```sh
git clone https://github.com/aditya-zig/VERIFAI.git
cd VERIFAI
npm install --no-audit --no-fund          # no lockfile: npm ci fails
./ops/local-agent/scripts/preflight.sh    # read-only machine and env report
./ops/local-agent/scripts/doctor.sh --stage M1
./start.sh                                # same as npm start
# open http://127.0.0.1:4173, paste a target URL, click Start local check
./ops/local-agent/scripts/stop-local.sh   # identity-verified stop
```

`doctor.sh` checks variable presence only. It never validates credentials,
model access, or SSO expiry; a presence PASS is not live proof
(`ops/local-agent/ENVIRONMENT.md`). For AWS Bedrock analysis, set the four
names from source only, nothing secret here: `AWS_REGION` (or
`AWS_DEFAULT_REGION`), `VERIFIAI_BEDROCK_MODEL_ID` (or `VERIFIAI_MODEL_ID`),
and a credential-chain source (profile/SSO or temporary credentials), then
`doctor.sh --stage M2`. Without them the API still serves, and analysis
returns Incomplete.

Observed here, unchanged by tests: this checkout ran the preflight only. It
reported Node v24.20.0, npm 11.19.0, 7250 MB total and 1698 MB available RAM,
Docker CLI installed with the daemon running, no AWS environment names
present, and port 4173 occupied by an unowned UI preview process from a
sibling checkout that this task must not touch. The disk line needs its own
caveat: preflight prints free space at the checkout root, and this checkout
is a scratch copy on a tmpfs `/tmp` tree, so it reported 3.3 GiB free on that
filesystem. Host disk-backed storage has 63 GiB free under `/home`. The
20 GiB sandbox build threshold is measured at the checkout root, so real
builds must run from a disk-backed checkout path.

## Automated checks, what exists and what it proves

| Command | Scope | Mode |
| --- | --- | --- |
| `npm run check` | external engine policy, typecheck, build plus unit, p0, p1, deep-audit demo | the full offline chain CI runs |
| `npm run typecheck`, `npm test` | TypeScript and unit suites, requires `node_modules` | offline |
| `npm run test:p0`, `npm run test:p1` | runtime and integration suites | offline; p1 model routing uses the Strands fixture |
| `npm run ops:test` | local-agent kit safety and behavior, 59 tests | offline |
| `./ops/local-agent/scripts/verify-local.sh` | honest runner: syntax, opstest, typecheck, e2e, each PASS, FAIL, or SKIPPED WITH REASON | offline |
| `npm run demo:e2e` | DeepAudit demo: guardrails enforced, fix stays not-run, prReady false | offline |
| `node scripts/ci-local-e2e.mjs` | structural E2E lane, credential-independent; the real-AWS lane is skipped with the opt-in rule printed | offline by default |
| `npm run test:local-e2e` | the full local E2E suite: depends on network clone, sandbox image, Chrome, and model/credentials | needs a real environment |
| `docker build -t verifai-local-audit:m4 ...` | CI builds the sandbox image; locally use `./ops/local-agent/scripts/build-sandbox.sh` | Docker, only when needed |

CI on `main` and each PR runs the check chain, builds the audit image, then runs
`ci-local-e2e.mjs` with `VERIFIAI_RUN_AWS_E2E=0`. A structural PASS does not
prove live Bedrock access (`ops/local-agent/VERIFY.md`).

## Offline capability limits

- `node_modules` is a hard prerequisite, not only for `tsc`. Both server roles
  import the analysis chain (`scripts/serve-web.mjs` → `services/local-audit.mjs`
  → `services/local-analysis.mjs` → `@strands-agents/sdk`), so web and API
  fail to start at import time without it. Observed in this checkout.
- Network reach out to github.com is required for the target clone; the Bedrock
  endpoint is required for analysis. A run with neither stops at Incomplete and
  cleans up the clone; that behavior is defined in source, not exercised here.
- Docker is used only for the selected command. A check run needs the built
  `verifai-local-audit:m4` image, and `build-sandbox.sh` refuses to build when
  the checkout root has under 20 GiB free. This scratch checkout sits on a
  tmpfs `/tmp` tree, 3.3 GiB free at its root, so no image was built here and
  the executed check stage stays unverified locally. That is a path property
  of the scratch copy, not a machine limit; a disk-backed checkout under
  `/home` with 63 GiB free satisfies the threshold.
- The browser journey drives an installed Chrome against a local fixture. On
  this machine Chrome exists at `/usr/bin/google-chrome-stable`. The journey
  tests the fixture, never the cloned application, and repair replay is
  same-command replay, not independent coverage (`docs/local-mvp.md`).
- Model severity stays an opinion with confidence Unconfirmed after any one
  bounded check, pass or fail. Only an admitted failed executed check enters
  repair, and only VerifiedRepair offers the explicit PR action.
- The explicit PR call (`services/local-pr-service.mjs`) requires a VerifiedRepair
  record, a proof manifest, `VERIFIAI_PR_APPROVAL_SECRET` or `VERIFIAI_STATE_SECRET`
  of at least 32 characters, and `VERIFIAI_GITHUB_TOKEN` or `GITHUB_TOKEN`. Names
  only here; no secrets were set or used for this document.
- Audit history lives in memory, bounded to 30 records, lost on restart.

## What was executed here, and what was not

Ran in this checkout on 2026-10-21, all offline, one process at a time:

- `./ops/local-agent/scripts/preflight.sh`, full read-only report as quoted above.
- `verify-local.sh` with `VERIFY_ONLY=syntax`: PASS, all seven kit scripts pass
  `bash -n`; then the full runner: `opstest` FAIL (2 of 59 tests), `typecheck`
  FAIL (`tsc: command not found`), `e2e` FAIL, so the run result is FAIL.
- `npm run ops:test` totals 59 tests, 57 pass, 2 fail. Both failures
  (`backend-env` root start script, `lifecycle-reconcile` la3 start/stop cycle)
  end in `ERR_MODULE_NOT_FOUND` when API start hits the missing dependency
  chain described above. These are environment gaps in this restriction-bound
  checkout, not release conclusions about configured environments.
- `npm run test:p0` and `npm run test:p1`: both runs fail on the same missing
  dependency imports at module load, before any test logic executes.
- `start-local.sh` while port 4173 was occupied: refusal, exit 1, occupant pid
  reported, nothing killed and nothing started, matching the described guard.

Not run here, by task constraint or missing capability: no `npm install` and no
dependency installation, no `tsc`, no sandbox image build, no Docker container
started, no test that itself starts containers (`local-sandbox.test.mjs`,
`master-failure.test.mjs`, and the container-backed parts of other E2E files),
no web or API server start, no model call, no `npm run check`, no demo flow,
no `verify:agentcore` or `verify:local-worker`, no JSON evidence writes.
The parent session owns test execution; other workers own pending changes.

## What remains for an application PR verification loop

The loop that exists today is the documented bounded local audit: clone, one
Bedrock-backed review, one bounded command, finding, cleanup, and the repair
path to VerifiedRepair. Its procedure stays in `docs/local-mvp.md`. That is a
repository-scoped audit. A verification loop for a real application PR does
not exist on main. The still-missing pieces, each against current source:

1. Exact PR intake integration. The audit target is a repository URL and its
   checkout. A PR loop must resolve the exact PR instead: base and head
   commit references, the changed-file set, and a head checkout. No route or
   service on main resolves an exact PR today.
2. Trusted base and head application execution with independent tests.
   Verifying a real change means running the application at base and head in
   the trusted bounded sandbox and collecting independent regression
   coverage. What exists is one bounded server-selected command replayed
   unchanged across repair; `docs/factory-gates.md` names that same-command
   replay and states it is not independent coverage.
3. Durable controller, jobs, and recovery. Run state is bounded in-memory
   history with workspace and sandbox recovery after restarts. PR
   verification that outlives a process needs durable jobs, a restart-safe
   controller, and event history. `docs/factory-gates.md` lists the durable
   controller, event history, and complete factory intake among the open
   pieces of #23 through #35, with reliable master acceptance (#11) and live
   AWS acceptance (#18) still pending.
4. Authenticated caller and human approval. The explicit PR action in
   `services/local-pr-service.mjs` gates creation behind VerifiedRepair, a
   proof manifest, and the two secret names in the limits above. There is no
   authenticated caller identity and no durable human approval step around
   PR creation. Human merge approval stays a rule, with no merge automation.
5. Head-bound GitHub Check and agent lifecycle interfaces. Verification
   output must attach to the PR's head commit as a GitHub Check, with
   interfaces to start a verification agent, read its status, and cancel it.
   The current server exposes none of these interfaces.
6. The repair and PR candidate inspector is being delivered separately.
   Recorded here as a pending resolution only: this document does not
   describe or exercise it, and nothing about it is claimed as present.

In-flight frontend branches carry the audit and deep-audit experience work.
This runbook assumes none of those changes until they merge, and once landed
they still need the fixture UI gates (`tests-p1/local-ui-gates.test.mjs`,
`tests-p1/local-result-ui.test.mjs`) plus a manual browser pass
(`ops/local-agent/VERIFY.md`).

## Explicit AWS acceptance exclusions

This work and this document claim none of these:

- No `VERIFIAI_RUN_AWS_E2E=1` anywhere; no Bedrock inference; no paid calls.
- No AgentCore anything: no runtime ARN use, no deployment, no execution IAM
  role verification, no ECR, ECS, Lambda, or CodeBuild calls. The A04 gate
  needs `AWS_ROLE_ARN`, `VERIFIAI_AGENTCORE_RUNTIME_ARN`, and
  `VERIFIAI_AGENTCORE_MODEL_PROFILE` configured in the repository before its
  manual acceptance workflow can run at all.
- No local AWS account or profile validation; preflight presence checks show
  names only and doctor cannot detect credential validity or expiry.
- No run in this checkout counts as live AWS proof. A structural or unit
  PASS proves the recorded checks' scope only.

## Sources read

`AGENTS.md`, `ops/local-agent/START-HERE.md`, `CURRENT-STATE.md`, `AGENT-RULES.md`,
`README.md`, `VERIFY.md`, `DOCKER.md`, `SETUP.md`, `TROUBLESHOOTING.md`,
`ENVIRONMENT.md`, `docs/local-mvp.md`, `docs/aws-runtime.md`,
`docs/factory-gates.md`, `docs/local-model-routing.md`, `CONTEXT.md`,
`package.json`, `start.sh`, the kit scripts, `scripts/ci-local-e2e.mjs`,
`scripts/demo-e2e.mjs`, `scripts/serve-local-api.mjs`, `scripts/serve-web.mjs`,
`services/local-pr-service.mjs`, the E2E test sources cited above, and the CI
workflow files. Live state checked with `gh run list` and `gh pr list`.
