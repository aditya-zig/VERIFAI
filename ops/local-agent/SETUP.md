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

See [`ENVIRONMENT.md`](ENVIRONMENT.md) for AWS configuration. M1 needs no
model credentials. Analysis defaults to `bedrock` and requires
`VERIFIAI_BEDROCK_MODEL_ID` (or `VERIFIAI_MODEL_ID`), `AWS_REGION` (or
`AWS_DEFAULT_REGION`), and a local AWS profile/SSO or temporary AWS credentials.
AgentCore workers use their execution IAM role. No third-party model keys.

Export configuration in the API shell, then run:

```bash
./ops/local-agent/scripts/doctor.sh --stage M2
```

Doctor reports presence only; it does not prove live access or model permission.
Live AWS E2E needs a separately authorized run and `VERIFIAI_RUN_AWS_E2E=1`.
Keep one heavy process at a time on the 8 GB machine; do not install Ollama.
