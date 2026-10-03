# Verify

One entrypoint for honest verification:

```bash
./ops/local-agent/scripts/verify-local.sh
```

Each check reports one of three states and the run exits non-zero if
anything FAILs:

- `PASS` — the command ran and exited 0.
- `FAIL` — the command ran and exited non-zero.
- `SKIPPED WITH REASON` — the npm script does not exist in this
  checkout, so there was nothing to run. This is never reported as PASS.

## What it runs

| Check | Command | When skipped |
| --- | --- | --- |
| `syntax` | `bash -n` over every kit script | never (kit scripts always exist) |
| `opstest` | `npm run ops:test` | `ops:test` missing from package.json |
| `typecheck` | `npm run typecheck` | `typecheck` missing from package.json |
| `e2e` | `npm run test:local-e2e` | `test:local-e2e` missing from package.json |

Real AWS model requests remain disabled unless `VERIFIAI_RUN_AWS_E2E=1` is
explicitly set with a model ID, region, and authorized credentials. Normal CI
uses `node scripts/ci-local-e2e.mjs` to run the structural lane and report the
live AWS lane as skipped. A structural PASS does not prove live Bedrock access.

The script inspects package.json at runtime. It never assumes a script
exists and never claims PASS for one it did not execute.

To run a subset (useful in tests and when iterating):

```bash
VERIFY_ONLY=syntax ./ops/local-agent/scripts/verify-local.sh
VERIFY_ONLY=typecheck,e2e ./ops/local-agent/scripts/verify-local.sh
```

Unknown check names exit 2 without printing PASS.

## UI changes need eyes, not just tests

For user-visible behavior, open the printed local URL
(`http://127.0.0.1:4173` for the web UI) and exercise the real flow in
a browser. Tests alone do not satisfy UI acceptance criteria.
