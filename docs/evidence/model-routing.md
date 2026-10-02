# Local hosted-model routing acceptance — 2026-10-02

Issue #71. Implemented on `feat/71-model-routing`, based on main
`ef8bd90faf25b756690daa86918ea2d499bf61be`. Humans review and merge.

## Executed evidence

- Deterministic checks: `npm run check` passed (54 core, 13 P0 and 145 P1
  tests); `npm run ops:test` passed (44 tests). Focused routing/security checks
  passed after the final changes. No live-model interpretation is asserted by
  these mocked HTTP fixtures.
- Real browser/API/Docker audit of `octocat/Hello-World`: default xkiro
  `qwen/qwen3.8-max:free`, one API attempt, actual README tracking command exit
  0, 1 GiB/2 CPU nonprivileged sandbox, automatic repository/container cleanup.
  The default screenshot was captured and visually inspected.
- Controlled live negative model selection: nonexistent xkiro model returned
  HTTP 404; the next configured Qwen Max route returned HTTP 200 and a valid
  tracked-file finding. Base review used two real API attempts. With opt-in M6,
  security review also used two real API attempts; its one historical review
  lease is separately reported from `specialists.apiAttempts: 2`.
- Real Qwen Coder Plus audit passed through the browser, actual Docker command
  and automatic cleanup after disabling the first route in a separate local
  configuration file. No default production configuration was altered for
  these negative/alternate selections.
- Startup RED/GREEN: a protected private env file alone initially yielded
  Incomplete with zero model requests. After API-only env loading was added,
  startup with provider keys removed from the launching environment completed
  the real default audit using the private file. The frontend did not load it.

Model findings stayed **Unconfirmed**. A passing README tracking command is
not security or suite verification. Real provider requests contained only
bounded public/owned fixture context; no raw authenticated response, reasoning
text, account identity or credential is included here.

## Honest limitations

The latest full development-only local E2E suite had **36/37 passing**. The
remaining M7 browser-route audit ended Incomplete during its bounded Docker
`ps` probe. The same failure was reproduced on unchanged main `ef8bd90`, with
its historical Ministral default. It is not claimed fixed or passing here;
Docker bounds/configuration were not widened to hide it. Consequently the full
`verify-local.sh` result is not a PASS. Two obsolete source-string UI assertions
were also reproduced on main, then replaced by existing/executable HTTP and
browser behavior checks rather than weakened source-pattern assertions.

Different-provider fallback, missing credentials, provider-wide skipping,
identity mismatch, invalid/oversized output, cancellation, deadlines and secret
handling have deterministic coverage. Token Harbor passed prior synthetic
checks, but a real cross-gateway repository audit was not completed in this
implementation pass. Gateway independence and long-term availability are not
established. NVIDIA/OpenRouter/Seek trial routes remain disabled.

The independent no-mistakes agent pipeline was initialized but not run; no
independent review or gate completion is claimed. This branch is published for
human review, not automatically merged or declared fully deployment-ready.

Local sanitized logs/screenshots/configurations are under workspace
`output/verifai-model-routing-20261002/`, outside the Git product checkout.
Credentials are in protected ignored local files, never in this evidence or Git.

## Reproduce

See [routing setup](../local-model-routing.md). Use the existing installed
Chrome and owned sandbox image; do not provision Docker/cloud infrastructure
merely to reproduce this feature. Run audits sequentially and stop only services
whose recorded process identity belongs to the checkout.
