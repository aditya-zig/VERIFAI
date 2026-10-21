# PR verification jobs

Tracking issue: [#85 durable pull request verification job state](https://github.com/aditya-zig/VERIFAI/issues/85). The route handler in `services/pr-verification/http.mjs` is owned by the parent session and is not part of this slice.

Status: durable job state, controller and recovery. No execution, no GitHub writes, no verdict is asserted by this slice.

This is the non-AWS job foundation for pull request verification. It adds the state a server route needs: a job that survives a restart, a controller that admits one job at a time, and a recovery pass that closes the jobs a dead process left behind.

Files:

- `services/pr-verification/store.ts` holds the durable store, the job record and the blocker list.
- `services/pr-verification/controller.ts` holds the route facing controller, the internal job controller, the adapter interfaces and the verdict seam.
- `services/pr-verification/recovery.ts` closes interrupted jobs and cleans proven owned resources.
- `tests/pr-job-store.test.ts`, `tests/pr-job-controller.test.ts`, `tests/pr-job-recovery.test.ts` and `tests/pr-job-api.test.ts` are the behaviour tests.

The contracts in `packages/contracts/src/index.ts` (`CandidateRevision`, `PrVerificationRequest`, `CheckPlan`, `CheckObservation`, `PrVerificationResult`, `PrJobPhase`) are unchanged. `RequestPrincipal` and `PrJob` are defined locally in `store.ts` because the request boundary, not the contract package, owns them.

## The route facing controller

```ts
import { PrVerificationController } from './services/pr-verification/controller.js';
import { PrJobStore } from './services/pr-verification/store.js';

const store = new PrJobStore({ directory: process.env.PR_JOB_DIR ?? './data/pr-jobs' });
await store.init();

const controller = new PrVerificationController({
  store,
  resolver,    // PrJobResolver:   request -> CandidateRevision
  planner,     // PrJobPlanner:    candidate -> CheckPlan
  executor,    // PrJobExecutor:   plan + candidate -> observations
  resources,   // PrResourceAdapter: allocate, inspect, release
  evaluator,   // PrJobEvaluator:  observations -> verdict
});
```

### Constructor options

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `store` | `PrJobStore` | yes | The durable store. The controller never creates one for you, so the route owns the directory and its permissions. |
| `resolver` | `PrJobResolver` | no | Turns a verification request into a candidate revision. Without one the job ends as `Incomplete` with `RESOLVER_UNAVAILABLE`. |
| `planner` | `PrJobPlanner` | no | Turns a candidate into a check plan. Without one the job ends as `Incomplete` with `PLANNER_UNAVAILABLE`. |
| `executor` | `PrJobExecutor` | no | Runs the planned checks. Without one the job ends as `Incomplete` with `EXECUTOR_UNAVAILABLE` and the limitation "no execution adapter is configured, so no check was executed". It is never `Verified`. |
| `resources` | `PrResourceAdapter` | no | Allocates, inspects and releases the resources of a job. Without one nothing is allocated and nothing is released. |
| `evaluator` | `PrJobEvaluator` | no | The verdict policy. Without one no job can become `Verified`. See the policy seam below. |
| `lockName` | `string` | no | Name of the single writer lock. Defaults to `controller`. |

### Store options

```ts
new PrJobStore({ directory, now?, idFactory? })
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `directory` | `string` | none | The store root. `init()` creates it and the `jobs` and `locks` directories with mode `0700`. |
| `now` | `() => Date` | `() => new Date()` | Clock used for `createdAt`, `updatedAt` and lock stamps. |
| `idFactory` | `() => string` | `() => job-<uuid>` | Job id source. The result must match the safe id pattern. |

### Methods

| Call | Behaviour |
| --- | --- |
| `start(input, principal, idempotencyKey)` | Authorizes the repository, admits the job and persists it as `Queued`. The same key with the same payload returns the same job. The same key with a different payload is refused with `IDEMPOTENCY_KEY_REUSED`. A different request is refused while another job is unfinished. |
| `get(id, principal)` | Returns the job. The owner always has access; another principal needs access to the repository. |
| `cancel(id, principal)` | Sets `cancelRequested`. Idempotent: asking twice keeps one request, and a job that already finished is returned unchanged. A job that has not started yet is closed as `Incomplete` right away. |
| `run(id)` | Drives one queued job to completion while holding the controller lock. |
| `tick()` | Runs the oldest queued job, if there is one. |
| `waitForIdle(options?)` | Waits until no job is unfinished. `options.timeoutMs` defaults to 30 000, `options.pollMs` to 25 and `options.drive` to `true`. With `drive` the wrapper also drives the queue while it waits; pass `drive: false` when another runner owns it. On timeout it raises `WAIT_TIMEOUT`. |

### Idempotency keys

The key is explicit and stable. It is the caller's own key, for example the `Idempotency-Key` header, and it must match `/^[A-Za-z0-9._:-]{1,200}$/`.

The key is scoped to the principal: `idem|<principal id>|<key>`. Two owners may use the same client key and get two different jobs. A replay with the same key and the same payload returns the job that already exists. A replay with the same key and a different payload is refused, because the key says one request and the payload says another.

`PrJobController.start(principal, request, { requestKey })` is the internal form. When no key is given it derives one from the owner, the repository, the pull request and the expected head, so a new push is a new request and not a replay of the old one.

## Job record

```ts
interface RequestPrincipal {
  id: string;
  kind: 'human' | 'agent';
  repositories: string[];
}

interface PrJob {
  id: string;
  ownerId: string;
  request: PrVerificationRequest;
  requestKey: string;
  phase: PrJobPhase;
  cancelRequested: boolean;
  candidate?: CandidateRevision;
  plan?: CheckPlan;
  resourceIntent?: PrJobResourceIntent;
  resourceIds: string[];
  result?: PrVerificationResult;
  verdict?: PrVerdict;
  failure?: { code: string; message: string };
  limitations: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

`phase` uses the contract vocabulary: `Queued`, `Resolving`, `Planning`, `Executing`, `Cleaning`, `Finished`. `Finished` is the only terminal phase. `verdict` is the job level outcome and is set when the job finishes.

`resourceIntent` records what the job intends to allocate before anything is allocated. `resourceIds` records what was allocated. Both are written before the executor runs.

## Store

The store keeps one JSON file per job under `<directory>/jobs/<id>.json`, one lock file per lock under `<directory>/locks/`, and one blocker list at `<directory>/blockers.json`.

| Property | Behaviour |
| --- | --- |
| Durability | The job body is written to a temporary file, fsynced, renamed over the target and the directory is fsynced. A reader sees the old body or the new body, never a half written file. |
| Atomicity | Every job file carries a SHA-256 checksum of its canonical body. A file that does not match its checksum is reported as corrupted, not ignored. |
| Compare and swap | `update(id, expectedVersion, mutate)` writes only when the stored version still equals `expectedVersion`. The read, the check and the write happen inside one critical section held by an exclusively created lock file, so two store instances cannot both win. |
| Versions | A created job is at version 0. Every successful update adds one. `mutate` retries a bounded number of times and re-reads between attempts. |
| Identifiers | Job ids must match `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`. Anything else is rejected with `INVALID_JOB_ID`, so a job id can never escape the store directory. |
| Permissions | The store directory, the `jobs` directory and the `locks` directory are `0700`. Every file is `0600`. |
| Snapshots | Every read returns a deep copy. A caller that mutates a returned job cannot change what is stored. |
| Unfinished work | `listUnfinished()` returns every job that has not reached `Finished`. |
| Corruption | `read` returns `null` only when the job does not exist. A broken file raises `CORRUPTED_STATE`; it is never reported as a missing job. |
| Locks | `acquireLock(name)` creates the lock file exclusively. A second writer gets `LOCK_HELD`. A lock left behind by a dead process can be broken with `stealStale`, which checks the recorded process id first. |

The store keeps a mutation lock of its own (`store-mutation`) so the compare-and-swap stays honest between processes. The controller takes a second lock (`controller`) while it drives a job, so only one controller writes the queue at a time. The controller lock is stolen when its owner process is gone, so a crash does not block the queue forever.

Blockers are the reason new work is refused. A blocker records a job, a reason and the resource identifiers that could not be proven safe.

## The policy seam

The verdict of a finished job belongs to an injected evaluator. This module does not hold a success policy.

```ts
interface PrJobEvaluator {
  evaluate(input: {
    job: PrJob;
    candidate: CandidateRevision;
    plan: CheckPlan;
    observations: readonly CheckObservation[];
    cancelled: boolean;
    cleanupComplete: boolean;
    limitations: readonly string[];
  }): { verdict: PrVerdict; limitations: string[] };
}
```

Without an evaluator the job uses `evaluateObservations`, a conservative fallback that is not a policy and never claims success. It reports what it can prove from the observations:

- an observation that states a failure becomes `Failed`,
- everything else becomes `Incomplete`,
- the limitations name the missing coverage, the mismatched test bytes, the wrong commit, the cancellation and the incomplete cleanup.

Without an evaluator no job can be `Verified`. The policy worker supplies the evaluator that decides what a complete observation set means.

The controller keeps two state machine rules whatever the evaluator says: a cancelled job and a job whose cleanup did not finish are downgraded to `Incomplete`.

## Adapter interfaces

```ts
interface PrJobResolver {
  resolve(input: { job: PrJob; request: PrVerificationRequest; signal: AbortSignal }): Promise<CandidateRevision>;
}

interface PrJobPlanner {
  plan(input: { job: PrJob; candidate: CandidateRevision; signal: AbortSignal }): Promise<CheckPlan>;
}

interface PrJobExecutor {
  execute(input: { job: PrJob; candidate: CandidateRevision; plan: CheckPlan; signal: AbortSignal }): Promise<{
    observations: CheckObservation[];
    superseded?: boolean;
    limitations?: string[];
  }>;
}

interface PrResourceAdapter {
  allocate(jobId: string, intent: PrJobResourceIntent): Promise<string[]>;
  inspect(jobId: string, resourceIds: readonly string[]): Promise<PrResourceState[]>;
  release(jobId: string, resourceIds: readonly string[]): Promise<{ released: string[]; failed: string[] }>;
}
```

`PrResourceState` is `{ resourceId, present, owned }`. `owned` means the adapter can prove the resource belongs to the job. An unproven resource is never deleted.

The `signal` is aborted when the job is cancelled. An adapter that ignores it still produces a cancelled job, because the controller checks the flag after every awaited step.

## Ordering guarantees inside `run`

1. The job is persisted as `Queued` before the resolver is called.
2. The candidate is persisted before planning starts.
3. The plan is persisted before anything is allocated. A plan that is already persisted is never replaced; a different plan for the same job raises `PLAN_CONFLICT`.
4. The resource intent is persisted before `allocate` is called.
5. The allocated identifiers are persisted before `execute` is called.
6. The job moves to `Cleaning` and the resources are released before the result is written.

Admission happens before any side effect. When a second distinct job is refused, no resolver, planner, executor or resource adapter has been called.

## Authorization

`principal.repositories` is the only authorization this slice implements. A request for a repository the principal does not hold is refused with `REPOSITORY_NOT_AUTHORIZED` and nothing is stored. Reading or cancelling the job of another owner needs repository access, otherwise the call is refused with `JOB_ACCESS_DENIED`.

## Cancellation

`cancel` marks the job and aborts the signal handed to the adapters. The runner checks the flag after every awaited step. A cancelled job always ends as `Incomplete`, never as `Verified`, and its resources are still released.

## Recovery

```ts
const outcome = await recoverInterruptedJobs({ store, resources });
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `store` | `PrJobStore` | none | The store to recover. |
| `resources` | `PrResourceAdapter` | none | Adapter used to inspect and release resources. |
| `queuedJobs` | `'keep' \| 'close'` | `'keep'` | A job that is still `Queued` has started no work. `keep` leaves it for the runner, `close` finishes it as `Incomplete`. |

Recovery looks at every job that has not reached `Finished`.

- An interrupted job is closed as `Finished` with `verdict = "Incomplete"`, `failure.code = "INTERRUPTED"` and, when a candidate and a plan were persisted, a result that carries an empty observation list. No observation is invented.
- Resources are released only when the adapter reports them as owned by the job. A resource that is present but not proven to be owned is never deleted.
- Anything that cannot be proven becomes a blocker. While a blocker exists the controller refuses to start a new job with `CLEANUP_UNRESOLVED`.
- A later recovery run inspects the blocked resources again. When the adapter can prove they are gone or that it owns them and the release succeeds, the blocker is cleared and new work starts again.

The outcome is `{ jobs, released, unresolved, blockers, blocked }`.

The route owns the adapters, so it holds the same resource adapter it gave to the controller and passes it here:

```js
import { recoverInterruptedJobs } from './recovery.js';

await recoverInterruptedJobs({ store, resources, queuedJobs: 'keep' });
```

`recovery.ts` does not import the controller, so the route can wire both without a cycle.

## Errors

| Code | Source | Status | Meaning |
| --- | --- | --- | --- |
| `INVALID_PRINCIPAL` | controller | 400 | The principal has no id, an unknown kind or a malformed repository list. |
| `INVALID_REQUEST` | controller | 400 | The repository, pull request number, expected head SHA or idempotency key is invalid. |
| `REPOSITORY_NOT_AUTHORIZED` | controller | 403 | The principal does not hold the repository. |
| `JOB_ACCESS_DENIED` | controller | 403 | The principal may not read or cancel this job. |
| `JOB_NOT_FOUND` | controller | 404 | No job with that id. |
| `ACTIVE_JOB_EXISTS` | controller | 409 | Another job is still unfinished. |
| `CLEANUP_UNRESOLVED` | controller | 409 | A previous cleanup is unproven, so no new job may start. |
| `JOB_NOT_QUEUED` | controller | 409 | The job is not in `Queued` and cannot be run. |
| `PLAN_CONFLICT` | controller | 409 | A different plan is already persisted for this job. |
| `CONTROLLER_BUSY` | controller | 409 | The controller lock is held by a live process. |
| `IDEMPOTENCY_KEY_REUSED` | controller | 409 | The idempotency key was already used for a different request. |
| `WAIT_TIMEOUT` | controller | 504 | `waitForIdle` gave up while jobs were unfinished. |
| `INVALID_JOB_ID` | store | 400 | The identifier is not a safe job id. |
| `VERSION_CONFLICT` | store | 409 | The stored version is not the expected version. |
| `JOB_EXISTS` | store | 409 | The identifier is taken. |
| `CORRUPTED_STATE` | store | 500 | A file is not readable, does not match its checksum or has an unknown shape. |
| `LOCK_HELD` | store | 409 | The single writer lock is taken. |

Every error carries `code` and `status`. A server route can map them directly.

## Gaps

- There is no runner service. `tick()`, `run(id)` and `waitForIdle()` are the hooks a runner uses.
- The resolver, planner and executor are interfaces. The GitHub candidate resolver in `candidate.ts` can back the resolver adapter, but that wiring is not part of this slice.
- The verdict policy is not part of this slice. Without an injected evaluator a job can only end as `Incomplete` or `Failed`.
- The resource adapter describes allocation, inspection and release. No resource service exists yet, so the default path allocates nothing.
- There is no job history. The record keeps the latest state only; a phase log would be a separate change.
- The single job limit is global for the store directory, not per repository or per owner.
- Recovery does not re-check the pull request head. A job recovered as `Incomplete` must be started again against the current head.

## Verification

```sh
npm run build
node --test dist/tests/pr-job-store.test.js
node --test dist/tests/pr-job-controller.test.js
node --test dist/tests/pr-job-recovery.test.js
node --test dist/tests/pr-job-api.test.js
```

The tests use real temporary directories, a real restart through a second store instance, real compare-and-swap conflicts, real concurrent admission and real recovery passes. They do not read the source of the implementation to decide what passes.
