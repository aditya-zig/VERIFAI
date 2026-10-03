# Final local verification

Scope: this page is the procedure for a future live acceptance run. The 3x public proof of 2026-10-01 ran against the older PR head and its evidence lives outside this repository; it is historical evidence, not a PASS for the current composition. The Docker, provider, and live-PR lanes below have not been re-run here and require explicit coordination before anyone runs them.

Use only after the human has created an authorized disposable public GitHub repository whose default `main` exactly contains the three files from `fixtures/public-proof/`.

## Required local environment

Presence only; do not paste values into logs or GitHub comments:

- `XKIRO_API_KEY`
- `VERIFIAI_GITHUB_TOKEN` (or `GITHUB_TOKEN`) with only the fixture-repository branch/content/PR permissions M10 needs
- `VERIFIAI_PR_APPROVAL_SECRET` (or existing `VERIFIAI_STATE_SECRET`), at least 32 characters
- `VERIFIAI_PUBLIC_PROOF_REPO=https://github.com/<owner>/<authorized-fixture-repo>`
- `VERIFIAI_PUBLIC_PROOF_BASE_SHA=<main SHA containing the intentionally broken fixture>`

Do not merge any generated repair PR.

## Exact laptop commands

```bash
git fetch origin
git switch remote/final-local-landing
git pull --ff-only

npm install --no-audit --no-fund
npm run check
npm run typecheck
npm run test:p1
docker build -t verifai-local-audit:m4 -f infra/local/audit.Dockerfile infra/local
npm run test:local-e2e
npm run ops:test

bash ops/local-agent/scripts/reconcile-local.sh
bash ops/local-agent/scripts/start-local.sh

VERIFIAI_PUBLIC_PROOF_RUNS=3 node scripts/final-public-proof.mjs

bash ops/local-agent/scripts/stop-local.sh
bash ops/local-agent/scripts/reconcile-local.sh
```

PASS requires three distinct run IDs, three distinct repair branches, three real unmerged PRs, matching artifact hashes, and proven local cleanup.

## Local-only work not on GitHub

Commit `4feb4ac` was not reachable remotely. Do not overwrite it. If it contains changes beyond the pushed M7/M6–M10 composition, cherry-pick only those local-only deltas onto this branch and rerun the exact commands above.
