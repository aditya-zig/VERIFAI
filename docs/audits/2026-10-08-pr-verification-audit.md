# VERIFAI progress and PR verification audit

Date: 8 October 2026. Audited source: `b88775d1defa1dd3152426c89f13a4028551799e` (GitHub `main`, including PRs #75, #77 and #79). This is a source, history and offline behavior audit. Live AWS deployment, paid inference and full target execution were not performed during this audit.

## Assessment

VERIFAI has a useful verification foundation, but the delivered product does not yet provide the PR runtime validation described by Greptile TREX. It currently clones a public repository's default branch, reviews bounded source, runs one narrowly permitted command, preserves proof and can verify a manually supplied repair before creating a new PR. It does not accept and validate an existing PR's complete candidate revision with its dependencies and running application.

The next release should prove one actual PR in one supported stack, through an agent-callable interface and an AWS worker. Retain the evidence and human merge rules. Expanding the number of agents or engines would not resolve the missing candidate verification loop.

The user's confirmed priority is **hackathon demo first, pilot later**. No current deadline or staffing was supplied. Estimates in the accompanying plan are engineering judgment, conditional on infrastructure access, rather than measured completion percentages or delivery promises.

## Sources and how conflicts were resolved

| Source | Evidence read | Interpretation |
| --- | --- | --- |
| Current GitHub | `main`, recent commits/PRs/CI, full issues #11, #18, #28, #74 | Current implementation and runtime direction |
| Pi history | VERIFAI-related user/assistant messages and compaction checkpoints across relevant sessions from 25 September–2 October; the 8 October match concerned other hackathon registrations | Historical intent, acceptance and unresolved work; previous instructions are context, not new authorization |
| [Grill with Docs](https://app.notion.com/p/3df074fda556811cb2c5c0829c126d41) | Thesis, ADR-C01–C08, glossary | Confirms trust layer for agent-written changes; popular repo auditing is secondary |
| [Master Execution & E2E Status](https://app.notion.com/p/3e4074fda556810d941cc96fdd127a5e) | Current section and historical milestone sections | Historical M5–M10 proof exists; this is not fresh Bedrock/AgentCore acceptance |
| [Agent Rules](https://app.notion.com/p/3de074fda55681ecb4c3c75cf8b02fd4), [local runner guide](https://app.notion.com/p/3e4074fda556815a9b81e956d5cfe31e), [AWS guide](https://app.notion.com/p/3e4074fda55681afb41fc70d6dd07289) | Product constraints, startup and deployment gates | Useful operational cautions; several branch/runtime statements are superseded |
| [Hackathon root](https://app.notion.com/p/3d5074fda55680b48c64e3f1e6919b7b), [team board](https://app.notion.com/p/3de074fda5568102aa9bfd49d2cb6caa) | Architecture and all returned Team Work rows (`has_more=false`) | Broad historical vision; some Done rows explicitly describe templates, deterministic demos or unexecuted deployments |
| [TrueForge migration](https://app.notion.com/p/3e7074fda5568112bc22f08e15d625d8) | Migration status and historical live attempts | Superseded by #74 / merged #75; do not restore this dependency |
| [Greptile TREX](https://www.greptile.com/trex) | Current official feature description | Reference behavior, not independent verification of vendor claims |

Notion's execution/runner pages were last edited on 2 October; the ADR/rules/deployment pages largely on 1 October. They still call #67/#68/#70 drafts and describe TrueForge as the next gate. GitHub shows those product changes merged and #75 replacing TrueForge with Strands, AgentCore and Bedrock. The older 20 September deadline is historical. Team-board Done counts cannot establish readiness for the current product. Notion was read, not edited, during this audit.

The original local checkout was at `b6b5ef6`, behind current `main`, with a pre-existing untracked lockfile. Its working files were preserved. A separate worktree based on current `main` was used for verification and this documentation.

## What is implemented, and what it proves

| Capability | Status | Actual scope / source |
| --- | --- | --- |
| Public repository intake | Implemented | `services/local-repository.mjs:157`: shallow default-branch clone, exact cloned commit recorded; no PR-number/head intake |
| Bounded source review | Implemented | `services/local-analysis.mjs:17`: up to 12 excerpts, 4,000 characters/file, roughly 12,000 total (last excerpt can exceed the total threshold); selection from first 100 reported paths, not changed-code selection |
| Real command isolation | Implemented | `services/local-command.mjs:20`, `services/local-sandbox.mjs`: `node --version`, single-file `node --check`, or tracked README check; no arbitrary npm scripts/dependency installation |
| Audit lifecycle / cleanup | Implemented, recent hardening | `services/master-audit.mjs`, `services/finding-evidence.mjs`: one audit lease, truthful Incomplete states, cleanup proof required |
| Claim/evidence separation | Implemented | Model allegation remains Unconfirmed; executed failure can be a repair target without confirming the allegation |
| Repair verification | Implemented, limited | `services/local-repair-service.mjs`, `services/local-repair-verification.mjs`: one text replacement in one existing file; before/after check, then same-command replay |
| Deterministic repair-to-PR gate | Implemented | `services/repair-verification-policy.mjs`, `services/verified-repair-pr.mjs`: executed facts, command identity, regressions, integrity, cleanup, patch/file hashes and evidence-bound approval |
| Proof downloads | Implemented | `services/local-artifact-service.mjs`, `services/proof-snapshots.mjs`: server-owned manifests and byte/hash verification |
| Browser evidence | Implemented fixture integration | `services/local-browser.mjs:1`: visits the verifier's own fixture, not the cloned candidate application |
| GitHub repair transport | Implemented | Exact base/file checks, preserves blob modes, pushes verified bytes and opens a PR; human merge remains separate |
| Strands/Bedrock/AgentCore workers | Code and contracts present | `services/agent-runtime/`, `services/orchestrator/`, `docs/aws-runtime.md`; real account/runtime parity remains pending #18/#74 |
| AWS target lifecycle | Infrastructure and adapter present | `services/bootstrap/aws-target-lifecycle.ts`, `infra/aws/real-target-stack.yml`; CodeBuild/ECR/Fargate/health/teardown are not fresh live proof |
| Specialist/engine orchestration | Scaffolding/adapters and tests present | Optional integrations require real endpoints; not demonstrated as a complete current cloud product |
| Durable hosted PR controller | Missing | Local and swarm records use memory maps; no complete hosted queue/leases/tenant ownership/PR publication path |

Committed `docs/evidence/M5.md` records ten real older-provider runs; Pi records real repair/proof/PR trials and later a 36/37 local E2E result with a Docker/browser timeout. These deserve credit, but use older revisions/providers and do not certify the new Bedrock path. GitHub #11 remains open. Retest the exact current revision, rather than erase historical proof or label old proof current.

## Gaps against the intended product

TREX's official page describes inspecting a PR and test setup, booting affected services, exercising changed code and attaching runtime evidence to the PR. VERIFAI needs the following loop to serve the user's goal:

`agent submits PR → resolve exact base/head → plan checks → boot isolated candidate → run real tests/requests → collect proof → deterministic verdict → publish on that head → agent repairs → rerun → human merge`

1. **Candidate identity:** PR number, head repository, base/head SHA and diff; changed-code context and invalidation on pushes/base changes. A default-branch audit does not test the submitted change.
2. **Runtime breadth:** dependencies, actual app startup, relevant tests and at least one API behavior check; cloned-app browser coverage comes later when the selected stack needs it.
3. **Trusted verification policy:** acceptance checks controlled from the approved base/config; candidate changes must not remove tests or weaken expectations to obtain green status. Generated tests supplement those checks.
4. **Agent integration:** authenticated start/status/cancel/evidence interface and a thin CLI/MCP adapter. Agents submit work and repair failures; they cannot author authoritative execution records.
5. **Cloud lifecycle:** durable queue/state/resource ownership, timeout/cancellation/recovery, private artifacts, account budgets and live parity proof.
6. **GitHub enforcement:** check on exact `head_sha`, rerun on updates, expected app as required check; report limits and missing coverage. A PR comment alone cannot gate a merge.
7. **Evaluation:** known bad and good candidate revisions, repeated runs, false-success and flakiness reporting. Test count and agent count cannot measure reduced bad-merge risk.

## Audit findings

### F1 — P1: mutations lack authenticated caller/approval identity

At `scripts/serve-web.mjs:69`, requests enter local routes without authentication, Origin or Host checks. `readJson` accepts JSON under `text/plain`. The `/pr` route calls `LocalPrService.create(auditId)`, which mints its own approval at `services/local-pr-service.mjs:21` and immediately uses it. Signing binds evidence correctly, but does not establish that a human approved publication.

**Observed:** an isolated instance of the actual API with an offline fake repository adapter accepted external Origin/Host and text/plain JSON, returned HTTP 201 and invoked clone once. No external clone or GitHub write was performed. This establishes server acceptance; browser-specific private-network protections were not tested. Any reachable caller knowing an eligible audit ID can request publishing with the backend token. The evidence gates still apply and this does not enable auto-merge.

**Required change:** authenticated principals, owner/repository checks, browser Origin/Host/CSRF protection, JSON-only writes, and a distinct evidence-bound human approval record. The agent service identity may verify; it may not issue human repair-publication approval.

### F2 — P2: malformed route encoding crashes the API

`scripts/serve-web.mjs:159` decodes the audit ID outside a catch boundary. Other route decodes have the same pattern.

**Observed:** `GET /api/local/audits/%ZZ` raised an uncaught `URIError` and terminated an isolated server with exit 1 under Node 24.20.0. Reproduced independently by the parent audit. No model, Docker or real repository operation occurred.

**Required change:** one top-level async request error boundary and safe route decoding; return 400, keep health and unrelated jobs available.

### F3 — P1 for enabling caller-controlled cloud builds: unquoted Dockerfile path

`services/bootstrap/aws-target-lifecycle.ts:106–107` interpolates `request.dockerfile` directly into shell lines. Unlike branch/repo/commit arguments, it is neither validated nor quoted.

**Observed:** invoking the compiled buildspec generator with `Dockerfile; echo VERIFAI_AUDIT_MARKER #` inserted a second shell command into both generated lines. No shell payload or cloud job was executed. Existing fixed profiles reduce current reachability; this becomes critical when accepting planner/user-selected paths for arbitrary PRs. The builder is privileged and has ECR push permissions (`infra/aws/real-target-stack.yml:275–299`).

**Required change:** validate a relative tracked Dockerfile path, reject control characters/traversal/symlinks, quote every use including diagnostics, and use trusted build profiles. An approved Dockerfile can still execute malicious dependency hooks; quoting alone does not separate candidate execution from the privileged builder/ECR role. The proposed demo uses a prebuilt trusted dependency image and materializes candidate source only as data; broader candidate builds require a credential-free executor and separate trusted publisher. Keep untrusted build steps away from controller/GitHub/model credentials. A domain allowlist is not a complete sandbox security policy.

### F4 — high product risk: published proof can become stale

`services/github-repair-transport.mjs:78–80` opens the PR using a mutable branch and discards the returned head SHA. There is no continuing check tied to the verified candidate. Subsequent pushes can leave old proof text beside new, unverified changes.

**Evidence level:** source-confirmed integration gap; a concurrent GitHub-writer race was not run. Bind publication to expected head, verify the returned head and invalidate/reverify after changes. Pilot merge-queue support must test the merge group too.

### F5 — P2 before broader intake: direct clone route bypasses admission/capacity bounds

`scripts/serve-web.mjs:238` clones directly; `services/local-repository.mjs:157` tracks clones but does not cap concurrent/retained clones or total bytes. The first-100-file listing caps presentation, not repository disk usage. Timeouts alone cannot prevent large clones from exhausting storage.

**Evidence level:** source-confirmed; no exhaustion test attempted. Route all intake through admission, byte/file/disk quotas, early abort and owned cleanup. Preserve the current single-heavy-operation limit locally.

## Verification performed

- `npm run check`: passed policy, typecheck/build, **64 core + 13 P0 + 168 P1 tests (245)** and demo script.
- `npm run ops:test`: **59 passed**, zero failures/skips. Total across these non-overlapping suites: **304**.
- Independent trust review: 29 selected safety/PR tests passed; these overlap existing suites and are not added to the total.
- Actual API crash and external-origin acceptance reproduced with isolated local processes/offline adapters. Buildspec injection reproduced by generation only.
- The demo script uses `acme/checkout` / `fixture-demo` and checks `prReady:false`; it is not current live PR/AWS acceptance. Normal CI explicitly sets `VERIFIAI_RUN_AWS_E2E=0`.
- Dependency installation was avoided by borrowing the existing dependency directory. Runtime used Node 24.20.0; CI specifies Node 22. Lockfile pinning and clean Node 22 reproduction are pilot work.

Not run: live Bedrock/AgentCore, full Docker/browser acceptance, actual candidate app, real OAuth/GitHub App installation, authenticated multi-user cloud API, live security probing, or cost/cleanup checks in an AWS account. Those are explicit completion gates, not inferred failures or PASS results. This review targets merge-risk-critical paths; it is not an exhaustive penetration test or line-by-line certification of every historical engine.

## What to do next

1. Fix F1–F3 and intake bounds in small reviewed PRs; establish current local/AgentCore live proof for #11/#18/#74.
2. Implement exact PR identity, agent interface and one trusted Node service verification profile.
3. Run real base/head tests and API requests in cloud isolation; retain current evidence semantics and finish cleanup before final verdict.
4. Publish a head-bound GitHub Check and demonstrate bad PR → failure → agent fix → rerun success → human merge.
5. Add private repos, tenant isolation, durable recovery, broader stacks/browser journeys, merge queues and calibrated evaluation for the pilot.

The implementation plan and spec in this PR supply interfaces, file ownership, task order and release gates. They propose new work; merging these documents does not mark the product or AWS deployment complete.
