# PR #66 local presentation integration — 2026-10-01

Upstream: [PR #66](https://github.com/aditya-zig/VERIFAI/pull/66) (`remote/ui-result-readability`,
reviewed head `086bc308dc99dd5fecb414cabf9d5ff79c2d7521`). Only its presentation helpers and
CSS were adapted. No remote guard, transport, or backend semantics were imported, and the
upstream file set was not merged.

## What was taken, what was refused

Taken and reworked for local evidence-ownership semantics:

- Summary chips, evidence cards, fact grids, stage facts, hash chips, sandbox facts.
- Collapsed `<details>` diagnostics with visible counts.
- Scoped wrapping (`overflow-wrap: anywhere`, `max-width: 100%`).
- Upstream badge-stretch and result-summary CSS collision fixes.

Refused:

- Upstream's shortened 12/16/32 hash prefixes standing alone. Full 64-char SHA-256 stays
  rendered beside every prefix.
- The generic `SAME-COMMAND REPLAY / limited coverage` fallback. When no coverage label is
  reported, the page says `coverage Not reported (not assumed SAME-COMMAND)`.
- `One real base API call` provenance wording. Controlled responses use neutral wording
  from server fields only.
- Boolean coercion of unknown sandbox facts. `undefined` renders `Not reported`, never
  `no` and never a green badge.

## Local semantics that stay strict

- Completed checks render `Completed limited check`, never full verification success.
- Model hypotheses render `Unconfirmed`, separate from executed evidence, with the
  assessment scope and reason attached.
- Repair admission is unchanged: `status === 'Failed'`, sandbox started, integer nonzero
  exit, no `timedOut` / `aborted` / `executed: false`. Only `VerifiedRepair` exposes the
  explicit human `Create PR` control. The backend still decides.
- Proof bundles render `Incomplete: <reason>` explicitly instead of vanishing.
- Downloads appear only for `Present` artifacts.

## Removed as genuinely unused

These CSS families shipped with the integration but no markup ever referenced them, so they
were deleted rather than carried as dead weight: `result-title`, `code-line`, `stream` /
`stream-label`, `json-block`, `evidence-rows` and its `row-*` children, `link-row`,
`artifact-link`, `artifact-reason`, the `evidence-note.safety` modifier, and the `chip`
ok/bad/warn tone variants (with the now-styling-less `tone` parameter). A test asserts the
surviving adapted classes do not collide with landing-page styles and that every surviving
adapted class is actually rendered.

## Verification on this integration

- Focused suites: `tests-p1/local-result-ui.test.mjs` (15), `result-cards-slice-c.test.mjs`
  (24), `local-ui-gates.test.mjs` (4). The VM seam extracts the real helpers from
  `apps/web/index.html` by brace matching and runs them beside the real `escapeHtml`.
  Nothing is mocked; negatives are preserved.
- Full `npm run check`: 54 compiled tests + 14 P0 + 125 P1, typecheck, policy, demo all
  passing. `npm run ops:test`: 42 passing. `git diff --check` clean.
- Browser layout (fixture scope only): the real renderer and real page CSS executed in
  headless Chrome against a controlled record with a 400-char command, 2000-char JSON
  diagnostic lines, full hashes, 25 console rows, and every `<details>` forced open.
  `document.documentElement.scrollWidth` equalled the viewport with zero overflowing
  elements at 380, 390, 1000, and 1280 px. No console errors. This is CSS/overflow
  evidence, not cloned-application verification and not live inference.

## Limits

- `tests-p1/result-renderer-harness.mjs` is test tooling, not a second renderer: it only
  extracts and runs the page's own functions.
- The six protected pre-existing files were not touched and remain unstaged.
- The accepted checkout (`local/verified-integration-20261001` at `4feb4ac`) does not
  contain this work. Nothing was pushed, merged, deployed, or published.
