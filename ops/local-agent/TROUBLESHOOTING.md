# Troubleshooting

Start here:

```bash
./ops/local-agent/scripts/preflight.sh
./ops/local-agent/scripts/doctor.sh --stage M1
```

## Known failures

- **Wrong repository.** The remote must be `aditya-zig/VERIFAI`. The
  sibling worktree `VERIFAI-e2e` belongs to a different repo
  (`aditya-zig/AWS-wemakedevs`) — do not work there.
- **Dependencies missing.** Run `npm install --no-audit --no-fund`.
  The repo has no lockfile, so `npm ci` fails; `npm install` is correct.
  Never commit the resulting `package-lock.json`.
- **Wrong Node version.** The repo standardizes on Node 22+. Node v24
  has been observed working.
- **`start:api` SKIPPED.** Normal unless the api build output and the
  full OAuth env block (`GITHUB_*`, `GOOGLE_*`,
  `VERIFIAI_STATE_SECRET`) are present. The M2 flow runs on web 4173 only.
- **Port 4173/8787 occupied.** `start-local.sh` refuses and reports the
  occupant (pid + command). Stop the owning process yourself unless the
  kit started it. The scripts never kill.
- **Stale kit state.** If a previous run died, `stop-local.sh` clears
  dead-PID state idempotently; `cleanup-local.sh` removes only the
  exact kit state dir
  (`/tmp/verifiai-local-agent-<uid>-vagent.<id>`).
- **`lsof` absent.** The scripts fall back to `ss`. No action needed.
- **Docker unavailable.** Informational only until M4. Never a blocker
  for M1/M2/M3 work.
- **Low disk (< 20 GB free).** Doctor warns; M4 Docker work stays
  deferred. Do not pull images.
- **Low RAM (~8 GB machine).** One heavy process at a time; stop the
  local services before running full typecheck + E2E suites.

## Stop rule

After two evidence-backed attempts at the same blocker, stop retrying.
Record the exact command, the error, the likely cause, and the smallest
next test. Do not keep retrying randomly.
