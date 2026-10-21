# PR candidate resolution

Tracking issue: [#82 Resolve immutable PR revisions before runtime verification](https://github.com/aditya-zig/VERIFAI/issues/82). This is the non-AWS candidate identity foundation proposed in PR #80 Task 2.

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
5. Read changed files through bounded pagination, 100 per page and at most 3,000 files. Reject missing patches, duplicate filenames, oversized patch data and any count that disagrees with `changed_files`. For each present patch, parse every unified hunk header and verify the hunk body consumes exactly the declared old and new line counts. Reject any patch whose parsed added or deleted line totals disagree with GitHub `additions`, `deletions` or `changes`. Accept `\ No newline at end of file` markers and 0-change renames with an absent or empty patch. Reject unknown diff lines and unsupported headers instead of digesting them.
6. Read PR metadata again. Reject with `CANDIDATE_CHANGED` when the base, head, repository identity, state, draft status or changed-file count moved while files were read.
7. Return `repository`, `pullRequest`, `headRepository`, `baseSha`, `headSha`, `mergeBaseSha`, sorted `changedFiles` and `diffDigest`.

## Diff digest

`candidateDiffDigest(files)` hashes UTF-8 canonical JSON. The payload is an array of `{ filename, status, patch }` objects sorted by filename, then status, then patch. SHA-256 is lowercase hex. Tests can call the exported function to reproduce the value.

The digest covers the validated, reported patch text. It is not a file-tree digest and does not cover unchanged file bytes. Hunk and count validation catches the truncation GitHub reports through mismatched metadata, but if GitHub ever returns a patch and metadata that agree with each other while both omit bytes, this digest cannot detect that. Treat it as a digest of the reported change, not a proof of complete changed bytes.

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
| Patch counts disagree, a hunk is incomplete or an empty patch accompanies reported changes | `FILE_PATCH_TRUNCATED` | 422 |
| Unknown diff line, malformed header or misplaced no-newline marker | `FILE_PATCH_UNSUPPORTED` | 422 |
| File count or patch bytes exceed limits | `FILE_LIST_OVERFLOW` | 413 |
| Unexpected GitHub response shape | `MALFORMED_GITHUB_RESPONSE` | 502 |

## Limits and remaining gaps

- Authorization is not implemented in this slice. A caller does not yet prove repository permission. That stays with the request boundary and controller work.
- Execution, evidence, verdict and GitHub Check publication are not implemented. Resolution never emits `Verified`.
- Fork, private, binary and truncated-patch PRs are rejected, not partially accepted.
- Patch validation is a consistency check, not a byte-completeness proof. A patch whose hunks and GitHub counts agree is accepted even though the digest still covers only reported patch text.
- GitHub rate limits and token scope are operator concerns. Public unauthenticated use is limited by GitHub.
- The inspection CLI bounds each GitHub request to 15 seconds through `FetchGitHubTransport({ timeoutMs })`. Resolution has no internal retry or backoff.
- A final head/base re-check after execution and before publication is still required. Resolution cannot make a later push safe.
