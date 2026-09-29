# Troubleshooting

Run:

```bash
./ops/local-agent/scripts/preflight.sh
./ops/local-agent/scripts/doctor.sh
```

Common failures:

- **Wrong repository**: remote must be `aditya-zig/VERIFAI`.
- **Wrong Node version**: use Node 22+; CI uses Node 22.
- **Dependencies missing**: run `npm install --no-audit --no-fund`.
- **M2 model config missing**: set provider, model ID, and the matching API key; never print the key.
- **Port 4173/8787 occupied**: stop the owning process yourself unless it was started by this kit.
- **Stale PID file**: `cleanup-local.sh` can remove kit-owned state safely.
- **Docker unavailable**: only a blocker at M4+.
- **Low RAM/disk**: stop heavy work; do not add parallel services.

Stop rule: after two evidence-backed attempts at the same blocker, record the exact command, error, likely cause, and next smallest test. Do not keep retrying randomly.
