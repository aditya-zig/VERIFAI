# Verify

Run the cheapest correct sequence available in the current checkout:

```bash
./ops/local-agent/scripts/verify-local.sh
```

The script:

1. syntax-checks this kit's shell scripts;
2. runs the repository typecheck;
3. runs `test:local-e2e` when that script exists;
4. otherwise runs the repository's existing `check` script;
5. refuses to claim PASS for a command that does not exist.

For UI behavior, also open the printed local URL and verify the real flow manually. Tests alone do not satisfy UI acceptance criteria.
