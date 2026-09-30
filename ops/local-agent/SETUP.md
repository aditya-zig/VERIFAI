# Setup

## Required now

- Git
- Node.js 22+ (Node v24 observed working)
- npm
- a normal browser for manual verification

`gh` is optional but useful for issue/PR work. Docker is optional until
M4 (see [`DOCKER.md`](DOCKER.md)).

## Repository setup

```bash
git clone https://github.com/aditya-zig/VERIFAI.git
cd VERIFAI
npm install --no-audit --no-fund
./ops/local-agent/scripts/preflight.sh
./ops/local-agent/scripts/doctor.sh --stage M1
```

Notes:

- The repo has no lockfile: `npm ci` fails, use `npm install`.
  Never commit the resulting `package-lock.json`.
- `node_modules/` is local-only and never committed.

## Environment

Copy the example and fill in values without committing secrets:

```bash
cp ops/local-agent/env/local.env.example ops/local-agent/env/local.env
```

See [`ENVIRONMENT.md`](ENVIRONMENT.md) for variable categories and
provider/key rules. Required keys depend on the milestone: M1 needs
none; M2 needs one provider key (`XKIRO_API_KEY` or
`OPENROUTER_API_KEY` — presence only, never print values).
