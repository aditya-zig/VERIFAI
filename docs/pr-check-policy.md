# Trusted PR check policy

This is the non-AWS policy layer for pull request verification. It decides what must run, keeps the approved tests immutable, stores their bytes before execution, and computes a verdict from recorded observations. It does not execute checks, call a model or touch AWS. A verdict produced here is only as good as the observations handed to it.

Files:

- `services/pr-verification/profile.ts` validates and freezes the approved profile.
- `services/pr-verification/planner.ts` builds a plan and keeps model output bounded.
- `services/pr-verification/evidence.ts` stores content-addressed test bytes.
- `services/pr-verification/verdict.ts` evaluates observations against the plan.
- `config/pr-demo-profile.json` is an example profile. Its commands are placeholders and were not run.

## Approved profile

A profile fixes the repository, policy commit, runtime image digest, dependency digests and the checks that must run. Required check scripts are part of the profile, so their digests are fixed too.

```ts
interface PrCheckProfile {
  profileId: string;
  policyVersion: string;
  repository: string;
  policyCommitSha: string;
  imageDigest: string;
  dependencyDigests: { name: string; sha256: string }[];
  requiredChecks: { checkId: string; command: string; script: string; timeoutMs: number }[];
  regressionCheck: { checkId: string; command: string; script: string; timeoutMs: number };
  profileDigest: string;
}

defineApprovedProfile(input: PrCheckProfileInput): PrCheckProfile
computeProfileDigest(profile: PrCheckProfileInput | PrCheckProfile): string
```

`defineApprovedProfile` validates the shape, rejects duplicate or reserved check ids, and rejects a regression command that repeats a required command. A same-command replay is not independent regression coverage. The returned object and its arrays are frozen. The profile digest is a SHA-256 over normalized profile content, including the scripts.

Limits are 1 to 8 required checks, 32 dependency digests, 300 command characters, 64 KiB per script and a 10 minute timeout.

## Planning

```ts
interface PlannerModelAdapter {
  propose(request: PlannerModelRequest): Promise<unknown>;
}

planChecks(input: {
  profile: PrCheckProfile;
  candidate: CandidateRevision;
  artifactStore: TestArtifactStore;
  model: PlannerModelAdapter;
}): Promise<{
  plan: CheckPlan;
  regression: TestDefinition;
  modelCalls: number;
  limitations: string[];
}>
```

The model is injected. The planner calls it at most twice and accepts only this shape:

```json
{ "generatedTests": [{ "checkId": "generated-edge", "script": "..." }] }
```

At most four generated tests are accepted. Unknown keys, duplicate ids, ids that collide with approved or regression checks, oversized scripts and extra tests reject the whole response. A rejected response leaves the approved checks unchanged and adds a limitation. The model never receives patch bytes, only repository, base and head SHAs and changed file names.

Approved and generated definitions are written to the artifact store before `planChecks` resolves. Generated commands are derived as `node --test artifact://tests/<sha256>`; the model cannot choose a command or add tools. The plan digest covers policy version, profile identity and every test definition.

## Test artifacts

```ts
class TestArtifactStore {
  constructor(root: string);
  persist(source: string): Promise<{ artifactRef: string; contentSha256: string; bytes: number }>;
  load(artifactRef: string): Promise<Uint8Array>;
  verify(definition: TestDefinition): Promise<Uint8Array>;
}
```

Bytes live under `<root>/tests/<sha256>`. The directory is mode 0700, files are mode 0600, and only a canonical `artifact://tests/<64 hex>` reference is accepted. Traversal strings, uppercase digests, longer paths, NUL bytes and relative roots are rejected.

`persist` writes with an exclusive handle and fsyncs before returning. If the same digest already exists, the existing bytes must match exactly or the store reports `TAMPERED`. `load` re-hashes every read and rejects symlinks, non-regular files and files over 64 KiB. A fresh store instance reads the same persisted bytes after a restart; edited bytes fail with `TAMPERED`.

`verify` also requires `definition.artifactRef` to equal `artifactRefFor(definition.contentSha256)`, so a definition cannot point at different bytes than the plan recorded.

## Verdict

```ts
evaluateCandidate(input: {
  candidate: CandidateRevision;
  plan: CheckPlan;
  profile: PrCheckProfile;
  observations: CheckObservation[];
  artifactStore: TestArtifactStore;
  cleanupComplete: boolean;
  superseded: boolean;
  modelOpinion?: PrVerdict;
}): Promise<{
  result: PrVerificationResult;
  reasons: { code: EvaluationReasonCode; detail: string }[];
}>
```

The evaluator re-hashes every artifact, checks the plan digest and profile digest, and requires exactly the approved required checks. It then checks each observation:

- the check id is in the plan;
- the revision is base or head and the commit SHA matches that revision;
- `executed` is true;
- the command digest matches the approved command;
- the test digest matches the persisted test bytes;
- at least one bounded, unique evidence reference exists;
- `exitCode` is a real integer, zero for Verified and nonzero for Failed.

Required and regression checks need base and head observations. Generated tests need a head observation. A check that did not run, a missing observation, a digest mismatch, an artifact that no longer hashes, incomplete cleanup or a superseded candidate yields `Incomplete`. Repeated observations of the same check and revision with different results are flaky and yield `Unknown`. A record with status Unknown also yields `Unknown`. A failure at base is disclosed and is not called a candidate regression.

A head failure on a check that passed at base, or a failing generated test, yields `Failed`. If every required, regression and generated check passes, cleanup completed and the candidate was not superseded, the verdict is `Verified`.

`modelOpinion` is accepted so callers can pass it through, but it is ignored. The limitations list records that it was ignored. Records decide the verdict.

`PrVerificationResult.evidenceManifestSha256` is a SHA-256 over the candidate, plan, observations, cleanup flag and superseded flag. Observation order does not change it. Any changed record does.

## What this does not prove

These modules do not run commands, start Docker, call a model, contact AWS or write GitHub checks. The tests use temporary files and controlled observations. No application was executed and no run proof is manufactured.

A passing verdict means the supplied records matched the approved policy. It does not authenticate arbitrary JSON as evidence, prove the commands ran, or replace human merge approval.

## Tests

```bash
npx tsc -p tsconfig.json --noEmit
npx tsc --outDir dist --rootDir . --module nodenext --moduleResolution nodenext \
  --target ES2022 --strict --esModuleInterop --skipLibCheck types/node-shim.d.ts \
  tests/pr-policy-*.test.ts
node --test dist/tests/pr-policy-profile.test.js dist/tests/pr-policy-evidence.test.js \
  dist/tests/pr-policy-planner.test.js dist/tests/pr-policy-verdict.test.js
```

The tests cover frozen profiles, rejected profile weakening, model attempt limits, real artifact bytes on disk, restart reads, tampering, traversal references, every verdict branch, base failure disclosure, flaky evidence and the ignored model opinion.
