# TrueForge Harness Migration

Branch: `aditya/trueforge-harness-migration`

Upstream harness: https://github.com/truefoundry/trueforge

This branch is intentionally isolated from the friend's active local E2E checkout. Do not merge it into that checkout until the migration gate below passes.

## Goal

Replace the Strands agent loop with TrueForge while preserving VERIFAI's existing product contracts:

- repository/target lifecycle
- audit API and UI
- specialist roles
- spend/time/concurrency guardrails
- evidence normalization and ownership
- real upstream engines
- truthful Confirmed / Unconfirmed / Unknown / Incomplete states

TrueForge owns the agent harness: model sessions, turns, MCP connectors, optional sandbox, context management and future subagent capabilities.

## Current migration status

Implemented on this branch:

- `VERIFIAI_AGENT_HARNESS=trueforge|strands`
- TrueForge REST/SSE client plus a dedicated Streamable HTTP MCP bridge using `@modelcontextprotocol/sdk`
- TrueForge-backed audit planner
- TrueForge-backed worker launcher
- TrueForge model credentials remain configured in TrueForge
- existing VERIFAI audit contracts and guardrails are preserved
- actual TrueForge `tool.response` events are recorded as executed runtime evidence
- model-only claims cannot promote themselves to Confirmed
- Strands/AgentCore remains a rollback path while parity is being tested

Not yet complete:

- VERIFAI-specific external-engine tools are not yet exposed to TrueForge through a scoped MCP bridge
- Browser Use/Cua/k6/Strix/ZAP/etc. therefore remain Incomplete on the TrueForge path unless an already-configured TrueForge MCP connector genuinely provides that capability
- no claim of local E2E PASS has been made for this migration branch
- Strands dependencies have not been deleted yet; remove them only after TrueForge parity + two complete UI audits

## Local TrueForge setup

TrueForge requires Node 22+.

Quick local server:

```bash
npx @truefoundry/trueforge
```

Default local API/UI origin:

```text
http://localhost:8790
```

Check:

```bash
curl -fsS http://localhost:8790/healthz
```

After the VERIFAI environment variables are set, run the no-generation preflight:

```bash
npm run verify:trueforge
```

It verifies harness selection, required model name, TrueForge reachability and auth mode without making a model generation request.

In TrueForge:

1. Open Settings -> Models.
2. Configure the model/provider using the API key already present on the machine.
3. Note the exact configured model name.
4. Open Settings -> Connectors.
5. Confirm only the MCP connectors VERIFAI should be allowed to use.
6. Keep TrueForge local-only unless login/network hardening is intentionally configured.
7. Configure a sandbox provider only if VERIFAI will enable TrueForge sandbox mode.

Do not copy provider secrets from TrueForge into Git, Notion, screenshots or VERIFAI config.

## VERIFAI environment

Minimum:

```bash
VERIFIAI_AGENT_HARNESS=trueforge
VERIFIAI_TRUEFORGE_BASE_URL=http://localhost:8790
VERIFIAI_TRUEFORGE_MODEL=<exact model name configured in TrueForge>
VERIFIAI_TRUEFORGE_TIMEOUT_MS=180000
```

If the TrueForge server uses OIDC login:

```bash
VERIFIAI_TRUEFORGE_TOKEN=<short-lived OIDC ID token>
```

Optional MCP connectors already registered in TrueForge:

```bash
VERIFIAI_TRUEFORGE_MCP_SERVERS=github,<other-scoped-connector>
VERIFIAI_TRUEFORGE_REQUIRE_APPROVAL_FOR_TOOLS=@destructive
```

Optional sandbox:

```bash
VERIFIAI_TRUEFORGE_SANDBOX=true
```

Only set sandbox=true after a TrueForge sandbox provider is actually configured.

## Start order

1. Start TrueForge.
2. Confirm `/healthz`.
3. Start only the VERIFAI services needed for the current local E2E path.
4. Start the audited target.
5. Open the VERIFAI web UI.
6. Submit one small real audit first.
7. Inspect TrueForge Sessions and VERIFAI audit evidence together.
8. Only after the small audit works, attempt the full two-audit local gate.

## What changes in execution

Before:

```text
VERIFAI API
  -> Strands planner
  -> Docker/AgentCore Strands worker
  -> VERIFAI worker tools
  -> external engines
```

Migration branch:

```text
VERIFAI API
  -> TrueForge planner session
  -> TrueForge worker session
  -> configured TrueForge MCP connectors / optional sandbox
  -> VERIFAI evidence normalizer
```

Target creation, reports, audit state, guardrails and evidence ownership remain VERIFAI responsibilities.

## Important evidence rule

A language-model answer is never enough for Confirmed.

The TrueForge launcher records real `tool.response` events. Generic connector output is treated as executed but outcome=unknown unless it contains a valid structured VERIFAI evidence object.

A worker requesting `Confirmed` is downgraded to `Unconfirmed` unless real executed non-LLM evidence has outcome=fail.

This rule must not be weakened during migration.

## VERIFAI MCP bridge — implemented, pending live validation

The migration branch now includes a dedicated Streamable HTTP MCP server named `verifiai-audit-tools`.

It exposes the existing real VERIFAI capabilities:

- `repo_tree`
- `repo_read`
- `target_http`
- `performance_probe`
- `mirofish_personas`
- `strix_scan`
- `zap_scan`
- `schemathesis_fuzz`
- `load_test` (k6 / Locust)
- `toxiproxy_fault`
- `computer_use` (Browser Use / Cua / generic)
- `apply_candidate_patch`

Worker identity is not accepted from model-provided audit IDs. VERIFAI signs the exact worker brief into a short-lived scope token. The bridge verifies that token server-side and then enforces the worker's repository, target, capabilities, network allowlist, destructive permission, timeout and spend bounds.

Unavailable engines return non-executed Incomplete/unknown evidence; they are never converted into PASS.

### Start the bridge

After `npm install` and `npm run build`:

```bash
npm run start:trueforge-tools
```

Default endpoints:

```text
http://localhost:8793/healthz
http://localhost:8793/mcp
```

The bridge loads `.env` automatically when started with the npm script. It uses `VERIFIAI_TRUEFORGE_MCP_SCOPE_SECRET`, falling back to `VERIFIAI_STATE_SECRET`. The selected secret must be at least 32 characters.

Verify the MCP server directly:

```bash
npm run verify:trueforge-tools
```

### Register it in TrueForge

With TrueForge already running on `http://localhost:8790` and the bridge healthy:

```bash
npm run configure:trueforge-tools
```

That upserts this TrueForge connector:

```text
name: verifiai-audit-tools
url:  http://localhost:8793/mcp
type: remote
auth: none
```

The configure command also asks TrueForge to list the connector's tools, so success proves TrueForge can reach the bridge.

Then enable the connector for VERIFAI workers:

```bash
export VERIFIAI_TRUEFORGE_MCP_SERVERS=verifiai-audit-tools
```

Keep destructive approvals enabled by default:

```bash
export VERIFIAI_TRUEFORGE_REQUIRE_APPROVAL_FOR_TOOLS=@destructive
```

The next proof is one small real tool-backed audit through VERIFAI -> TrueForge -> `verifiai-audit-tools`.

## Migration gate

Do not delete Strands yet.

TrueForge becomes the only harness after all of these are true:

- [ ] TrueForge health succeeds from VERIFAI
- [ ] planner returns a valid bounded worker plan
- [ ] worker session streams real events
- [ ] dedicated VERIFAI MCP bridge is connected
- [ ] one real external engine executes through TrueForge
- [ ] Browser Use lane produces real screenshot/action evidence or is truthfully Incomplete
- [ ] k6/performance lane produces real metrics
- [ ] UI shows progress and terminal report
- [ ] restart + artifact ownership checks pass
- [ ] cleanup is verified
- [ ] audit 1 passes the full local gate
- [ ] audit 2 passes with a fresh audit/target
- [ ] final `npm run check` passes
- [ ] no secret appears in logs/UI/artifacts

Then:

1. record a rollback tag/branch;
2. remove `@strands-agents/sdk`;
3. delete Strands-only planner/worker code;
4. remove AgentCore worker runtime resources that are no longer used;
5. update architecture docs and AWS deployment docs to host/reach TrueForge appropriately;
6. rerun the full local gate and one credentialed cloud gate.

## Friend laptop rule

The friend's current E2E work is the baseline, not the migration workspace.

Do not ask the friend to switch branches mid-run. Finish and record the current baseline first. Then clone/check out this migration branch into a separate directory and compare:

```text
baseline E2E result
vs
TrueForge migration result
```

Never overwrite the working transferred checkout or its local evidence.

## Rollback

Temporary rollback only:

```bash
VERIFIAI_AGENT_HARNESS=strands
```

The rollback exists to compare behavior during migration. New architecture work should target TrueForge.
