# PR verification HTTP interface

The local web/API server mounts this interface after its loopback Host and
Origin checks. Authentication resolves an operator-configured principal on the
server. A request cannot supply a principal, plan, observation or verdict.

All routes use `/api/local/pr-verifications` and require authentication.

- `POST /` accepts `repository`, `pullRequest` and `expectedHeadSha`. Supply an
  `Idempotency-Key` header containing 8 to 128 letters, digits, dots, underscores
  or hyphens. A successful admission returns HTTP 202 and `{job}`.
- `GET /:id` returns the caller's job. The controller enforces ownership.
- `POST /:id/cancel` requests cancellation and returns the updated job. It
  accepts no execution data.
- `GET /:id/evidence` returns the recorded candidate, plan and result when
  available. Before a result exists, it returns `status: "Pending"`.
- `GET /capabilities` reports configured execution and publication adapters.
  Configured capability is not live AWS acceptance.
- `POST /:id/publish` lets an authenticated human explicitly publish the
  stored terminal result as a GitHub Check. It accepts no result in the body.
  Agent principals cannot call this write endpoint.

Request bodies are JSON objects bounded to 32 KiB. Invalid input returns 400,
unsupported content types 415, and unsupported methods 405. Missing configured
capability returns 503 instead of synthetic success. Internal errors do not
return exception messages or credentials to the caller.

`services/pr-verification/http.mjs` accepts an injected controller and
authentication callback. The HTTP tests exercise real requests with controlled
controller behavior. They prove routing and admission behavior, not candidate
execution, cloud readiness or GitHub publication.

## Agent client

`node scripts/verifai-job.mjs --help` lists start, status, cancel, evidence and
capabilities commands. Set `VERIFIAI_AGENT_TOKEN` in the caller's environment
and configure the matching scoped principal in the backend. Do not put tokens
on the command line. The client permits only a loopback HTTP origin in
`VERIFIAI_API_URL`, refuses redirects and bounds each request to 15 seconds.

The launcher compiles the TypeScript services before starting either role.
`./start.sh --help` and unsupported-argument handling still delegate directly
without starting services or compiling code.

Check publication remains disabled unless the backend operator supplies
`VERIFIAI_GITHUB_APP_TOKEN` and sets
`VERIFIAI_PR_STRICT_BRANCH_PROTECTION_ACK=1`. The acknowledgment is not a
verification of branch protection. Configure and validate required checks in
GitHub separately. Publication records persist privately and remote writes
hold a per-job lock. A lock left behind by a publisher that died is broken on
the next attempt; a lock held by a live publisher is never taken, and the
refused request writes nothing. No publication or merge happens automatically.
