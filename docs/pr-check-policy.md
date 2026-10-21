# Trusted PR check policy

This is the non-AWS policy layer for pull request verification. It decides what must run, keeps the approved tests immutable, stores their bytes before execution, and computes a verdict from recorded observations. It does not execute checks, call a model or touch AWS. A verdict produced here is only as good as the observations handed to it.

Files:

- `services/pr-verification/profile.ts` validates and freezes the approved profile.
- `services/pr-verification/planner.ts` builds a plan and keeps model output bounded.
- `services/pr-verification/evidence.ts` stores content-addressed test bytes and evidence records.
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
loadApprovedProfile(path: string, options?: { maxBytes?: number }): Promise<PrCheckProfile>
computeProfileDigest(profile: PrCheckProfileInput | PrCheckProfile): string
```

`defineApprovedProfile` validates the shape, rejects duplicate or reserved check ids, and rejects a regression command that repeats a required command. A same-command replay is not independent regression coverage. The returned object and its arrays are frozen. The profile digest is a SHA-256 over normalized profile content, including the scripts.

`loadApprovedProfile` reads an absolute path, rejects symlinks, non-files and oversized files, accepts a UTF-8 BOM, and then runs the same validation. It has no environment override, remote fetch or model fallback. The default file bound is 1 MiB and the maximum is 4 MiB.

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
  model?: PlannerModelAdapter;
  limits?: { maxModelCalls?: number; maxGeneratedTests?: number };
}): Promise<{
  plan: CheckPlan;
  regression: TestDefinition;
  modelCalls: number;
  limitations: string[];
}>

planCandidate(
  profile: PrCheckProfile,
  candidate: CandidateRevision,
  options: {
    model?: PlannerModelAdapter;
    artifactStore?: TestArtifactStore;
    artifactsRoot?: string;
    maxModelCalls?: number;
    maxGeneratedTests?: number;
  },
): Promise<PlannedCheckPlan>
```

The model is optional and injected. When no adapter is configured, the planner still persists the approved checks and the independent regression, makes zero model calls, plans no generated tests and records one explicit limitation that generated checks and planning are unavailable. It does not inject a fake adapter or claim that anything was proposed. The fixed plan remains inspectable and can be validated before execution.

When an adapter is present, the planner calls it at most twice and accepts only this shape:

```json
{ "generatedTests": [{ "checkId": "generated-edge", "script": "..." }] }
```

At most four generated tests are accepted. Unknown keys, duplicate ids, ids that collide with approved or regression checks, oversized scripts and extra tests reject the whole response. A rejected response leaves the approved checks unchanged and adds a limitation. The model never receives patch bytes, only repository, base and head SHAs and changed file names.

Approved and generated definitions are written to the artifact store before `planChecks` resolves. Generated commands are derived as `node --test artifact://tests/<sha256>`; the model cannot choose a command or add tools. The plan digest covers policy version, profile identity and every test definition.

`planCandidate` is the jobs-worker entry point. It requires exactly one of `artifactStore` or `artifactsRoot`, caps caller limits at the server bounds, and delegates to `planChecks`. `maxGeneratedTests: 0` skips the adapter entirely. `model` is optional for the fixed-check path. There is no default model and no default executor.

## Plan validation

```ts
validatePlan(input: {
  profile: PrCheckProfile;
  plan: CheckPlan;
  artifactStore?: TestArtifactStore;
  verifyArtifacts?: boolean;
}): Promise<{
  ok: boolean;
  issues: { area: 'profile' | 'plan' | 'artifacts'; code: string; detail: string }[];
}>
```

Validation is offline and returns issues instead of throwing, so a job can record Incomplete with a precise reason. It checks the profile digest, regression independence, plan identity and digest, the exact set of approved checks, generated bounds and, by default, re-hashes every referenced test artifact. Pass `verifyArtifacts: false` only for a structural check before bytes exist. With verification enabled, an omitted `artifactStore` is itself reported as an issue.

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

```ts
class EvidenceWriter {
  constructor(root: string, options?: { maxRecordBytes?: number });
  write(record: unknown): Promise<{ evidenceRef: string; contentSha256: string; bytes: number }>;
  read(evidenceRef: string): Promise<{ record: unknown; bytes: Uint8Array; contentSha256: string }>;
  pathFor(contentSha256: string): string;
}
```

`EvidenceWriter` stores caller-supplied JSON records as `evidence://records/<sha256>` under `<root>/records`. It has the same 0700 directory, 0600 file and re-hash-on-read rules, and it rejects non-JSON values, cycles, non-finite numbers and records over the configured bound. It never creates a record, fills a verdict or marks a check passed. A worker writes the adapter's own observation and places the returned reference in `CheckObservation.artifactRefs`.

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
  evidenceStore?: EvidenceWriter;
  requireGeneratedTests?: boolean;
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

When `evidenceStore` is supplied, every `evidence://records/...` reference is re-hashed through `EvidenceWriter`. A missing or edited record yields `Incomplete`. Other adapter-defined references stay format checked, because this layer cannot know their backing store.

`requireGeneratedTests` defaults to false. Set it when generated coverage is a policy requirement. A plan with no generated tests then yields `Incomplete` with a generated coverage reason, even if every approved check passed. Leave it false when a fixed approved plan is only preparation.

A head failure on a check that passed at base, or a failing generated test, yields `Failed`. If every required, regression and generated check passes, cleanup completed and the candidate was not superseded, the verdict is `Verified`.

`modelOpinion` is accepted so callers can pass it through, but it is ignored. The limitations list records that it was ignored. Records decide the verdict.

`PrVerificationResult.evidenceManifestSha256` is a SHA-256 over the candidate, plan, observations, cleanup flag and superseded flag. Observation order does not change it. Any changed record does.

## Jobs worker flow

1. Load the approved profile with `loadApprovedProfile` from the configured absolute path.
2. Receive the resolved candidate from the parent route or job payload.
3. Call `planCandidate` with the profile, candidate and an absolute artifact root. Pass the model adapter when generated coverage is available; omit it for the fixed-check preparation path.
4. Call `validatePlan` on the returned plan before execution. Stop with Incomplete if it fails.
5. Run the approved commands and generated commands through the real execution adapter. The adapter writes each raw record with `EvidenceWriter` and returns a `CheckObservation` with the matching commit SHA, command digest, test digest, integer exit code and evidence reference.
6. Call `evaluateCandidate` with the same profile, plan, store and observations, plus the cleanup and supersession facts.
7. Publish the returned `result` through the parent route. Policy code does not write PR comments, checks or merges.

There is no executor default, retry loop or synthetic observation in this layer. A worker that cannot produce a record leaves the check missing, which becomes Incomplete.

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
  dist/tests/pr-policy-planner.test.js dist/tests/pr-policy-verdict.test.js \
  dist/tests/pr-policy-load.test.js
```

The tests cover frozen profiles, file loading, rejected profile weakening, model attempt limits, caller limit caps, plan validation, real artifact bytes on disk, evidence records, restart reads, tampering, traversal references, every verdict branch, base failure disclosure, flaky evidence and the ignored model opinion.
