# Current state

Checked: 2026-09-29.

- Canonical repository: `aditya-zig/VERIFAI`.
- Active strategy: local-first reliability on an 8 GB laptop.
- Models: API-backed only. Do not install or use Ollama.
- Heavy work: one model/agent/heavy process at a time.
- Docker: deferred until M4.
- AWS, Vercel, TrueForge, multi-agent, repair, proof, and software-factory expansion: deferred until their roadmap gate. Software-factory issues #22-#35 stay blocked until reliable M5.

## Canonical roadmap

- #4 — local-first reset map
- #5 — M0
- #6 — M1, implemented in PR #19 but still open/unmerged when this file was written
- #20 — M2
- #9 — M3
- #10 — M4 Docker
- #11 — M5 master local E2E
- #12-#18 — later verification/runtime/cloud slices

## Merge/blocking snapshot

At the time of writing, PR #19 (`m1-local-repository`) is open against `main`. Its local E2E was reported green 3x with a manual browser check, but the repository-wide `npm run check` still had a P0 expectation conflict with the new local-first landing page. Do not assume this is still true.

`main` still contains older cloud-first/Deep Audit infrastructure. Treat that as migration debt, not permission to start cloud work early.

## Recheck before every task

These facts become stale quickly and must be rechecked on GitHub:

- issue/PR open/closed/merged state;
- branch names and head SHAs;
- CI status;
- package scripts;
- current acceptance criteria;
- whether `test:local-e2e` has merged into `main`;
- which provider/model M2 currently uses.

Notion pages to read before coding:

- `READ FIRST — Agent Rules & Project Context`
- `VERIFAI — Master Execution & E2E Status`
