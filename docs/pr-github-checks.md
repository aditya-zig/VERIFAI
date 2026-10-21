# PR GitHub Check publication

Status: head-bound publication foundation. This does not replace the verdict pipeline, does not merge anything and does not close #28.

`services/pr-verification/github-checks.ts` publishes one trusted, server-produced `PrVerificationResult` as two bounded GitHub writes through the injected `GitHubTransport`: the `VERIFAI runtime verification` check run bound to the exact candidate head SHA, and one evidence comment on the pull request. It publishes the check for the current head only, never for a proof whose pull request has moved on.

## What it is not

- It does not create repair pull requests, approve anything, or merge. Humans approve merges.
- It does not authenticate result payloads. It must be called from server code with a result produced by the runtime verifier; the controller must never hand it a `PrVerificationResult` that arrived from an unauthenticated client.
- It does not verify repository branch protection settings. The caller must set `assumeStrictBranchProtection: true` to state explicitly that the VERIFAI check is enforced (or to accept the assumption consciously). Without that explicit affirmation nothing is written.

## Publication sequence

1. Validate the config, the request (`owner/repo`, positive PR number, 40-character expected head SHA) and the result structure before any GitHub call.
2. Reject results bound to a different repository (`RESULT_REPOSITORY_MISMATCH`), pull request (`RESULT_PULL_REQUEST_MISMATCH`) or head SHA (`RESULT_HEAD_MISMATCH`), fork heads, absent evidence manifests, incomplete cleanup and results already marked superseded. Rejections happen before the first network read.
3. For `Verified`, require full justification: every required planned check needs a matching observation with `revision: "head"`, the candidate commit SHA, the planned test content digest, `executed: true`, exit code 0 and status `Verified`. A contradictory failed or incomplete observation also rejects. Anything less publishes nothing as success.
4. Re-fetch live PR metadata. Closed or merged PRs, drafts, forks and non-matching head/base metadata stop the write. A moved head or base returns `outcome: "superseded"` without writing, so an old proof is never labelled current.
5. Write the check run. New heads create a run with `external_id: verifai-runtime:<repo>#<pr>@<headSha>`; retries update the recorded run in place.
6. Write one evidence comment keyed by an invisible HTML marker. Retries update the same comment.
7. Persist the repository, pull request, head, check id, comment id, external id and principal through the injected `PrChecksPublicationStore` after each write, so a restarted process can reconcile an external id it did not record.
8. Re-fetch PR metadata after the writes. If the head or base moved during publication, a check that was just published as `success` is rewritten to `neutral` with a superseded summary, and the comment is rewritten with a superseded notice. The call returns `outcome: "superseded"`.

## Verdict mapping

| Result verdict | Check conclusion |
| --- | --- |
| `Verified` | `success` |
| `Failed` | `failure` |
| `Incomplete` | `action_required` |
| `Unknown` | `action_required` |

`Incomplete` and `Unknown` always ask for a human or a re-run; they never publish success. Model-generated tests in the plan stay labelled unconfirmed hypotheses in the published text and can never justify a `Verified` verdict by themselves.

## Idempotence and reconciliation

Retries in the lifetime of one store update the recorded check run and comment through PATCH, so no duplicates appear per head SHA. If the process restarted before persisting ids, the module scans the check runs at the head SHA for its external id and the issue comments for its invisible marker, then updates the existing entries. A store record never contains the token.

## Text safety

Published text is bounded: `PR_CHECKS_LIMITS` caps the summary, the comment, the number of quoted limitations and the per-limitation characters. Limitations render inside `~~~` fences after stripping control characters, backticks and markup triggers, so verifier text cannot inject links, headings or code spans. The module constructs no URLs from untrusted input and never includes the token or the principal in GitHub payloads; the principal is persisted to the store only.

## Remaining gaps

- Branch protection enforcement is an assumption, not a verified fact. An operator who flips the flag without configuring protection still leaves the branch mergeable.
- Comment reconciliation matches the invisible marker with a bounded 100-entry scan; a pull request with more than 100 comments where our comment fell into a later page will reconcile to a fresh comment instead of the original one.
- The post-write currency check tolerates a failed re-read by returning `outcome: "published"` with `reason: "POST_WRITE_VERIFY_FAILED"`; callers should treat that as "current-ness unconfirmed" and retry, which is safe.
- No controller wiring yet: nothing calls this module. The controller slice must own reading the token from environment configuration and must apply storage and access checks before invoking it.
- Publication of failure/action_required conclusions still requires complete cleanup and a valid evidence manifest; a verifier that cannot clean a candidate leaves no trace on GitHub, by design.
