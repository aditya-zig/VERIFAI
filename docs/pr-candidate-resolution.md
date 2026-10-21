# PR candidate resolution

Status: foundation only. This does not run verification and does not close #28.

`services/pr-verification/candidate.ts` resolves one public, same-repository pull request into an immutable candidate identity. It reuses `GitHubTransport` and performs reads only.

## Command

```sh
npm run build
node scripts/verifai-pr.mjs inspect \
  --repository owner/repo \
  --pr 123 \
  --expected-head <40-character-sha>
```

The command reads an optional token from `GITHUB_TOKEN` or `GH_TOKEN`. It never accepts a token argument, never prints one, and sends credentials only through `FetchGitHubTransport` to `api.github.com`. Output contains the resolved candidate plus `execution.state: "pending"` and `verdict: null`.

## Resolution sequence

1. Validate `owner/repo`, a positive integer PR number and a 40-character expected head SHA. Invalid input stops before any GitHub request.
2. Read live PR metadata. Reject closed, merged, draft, cross-repository (fork), private, malformed or SHA-less responses.
3. Require the live head SHA to equal the expected head.
4. Read GitHub's compare result for the live base and head. Reject when the base is not an ancestor of the head and pin the reported merge-base SHA.
5. Read changed files through bounded pagination, 100 per page and at most 3,000 files. Reject missing patches, duplicate filenames, oversized patch data and any count that disagrees with `changed_files`.
6. Read PR metadata again. Reject with `CANDIDATE_CHANGED` when the base, head, repository identity, state, draft status or changed-file count moved while files were read.
7. Return `repository`, `pullRequest`, `headRepository`, `baseSha`, `headSha`, `mergeBaseSha`, sorted `changedFiles` and `diffDigest`.

## Diff digest

`candidateDiffDigest(files)` hashes UTF-8 canonical JSON. The payload is an array of `{ filename, status, patch }` objects sorted by filename, then status, then patch. SHA-256 is lowercase hex. Tests can call the exported function to reproduce the value.

## Rejections

| Condition | Code | HTTP status |
| --- | --- | --- |
| Bad repository, PR number or expected head | `INVALID_*` | 400 |
| Closed or merged PR | `PULL_REQUEST_CLOSED` | 409 |
| Draft PR | `PULL_REQUEST_DRAFT` | 409 |
| Fork or cross-repository PR | `FORK_PULL_REQUEST_UNSUPPORTED` | 403 |
| Private base or head repository | `PRIVATE_REPOSITORY_UNSUPPORTED` | 403 |
| Expected head differs from live head | `EXPECTED_HEAD_MISMATCH` | 409 |
| Base is not an ancestor of head | `BASE_NOT_ANCESTOR` | 409 |
| Metadata moved during resolution | `CANDIDATE_CHANGED` | 409 |
| Missing or malformed commit SHA | `MISSING_COMMIT_SHA`, `INVALID_COMMIT_SHA` | 502 |
| File list count mismatch | `FILE_LIST_TRUNCATED` | 422 |
| Binary or omitted patch data | `FILE_PATCH_UNAVAILABLE` | 422 |
| File count or patch bytes exceed limits | `FILE_LIST_OVERFLOW` | 413 |
| Unexpected GitHub response shape | `MALFORMED_GITHUB_RESPONSE` | 502 |

## Limits and remaining gaps

- Authorization is not implemented in this slice. A caller does not yet prove repository permission. That stays with the request boundary and controller work.
- Execution, evidence, verdict and GitHub Check publication are not implemented. Resolution never emits `Verified`.
- Fork, private, binary and truncated-patch PRs are rejected, not partially accepted.
- GitHub rate limits and token scope are operator concerns. Public unauthenticated use is limited by GitHub.
- A final head/base re-check after execution and before publication is still required. Resolution cannot make a later push safe.
