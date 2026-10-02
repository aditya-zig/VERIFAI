# Evidence ownership — implementation notes (2026-10-01)

Source titles from VERIFAI — Grill with Docs (Notion, 2026-10-01 08:55 UTC). Decision assumptions only. No new ADR.

## What changed

Slice A added `services/finding-evidence.mjs` as the single owner of claim-to-check meaning. `master-audit.mjs` keeps model text verbatim and attaches execution structurally with commit, command and source provenance. `local-repair-service.mjs` enforces the strict predicate (status Failed, sandbox started, integer nonzero exit) and records SAME-COMMAND REPLAY coverage with the model hypothesis stored separately. `local-repair-verification.mjs` accepts a verified executed-command target while the allegation stays Unconfirmed, keeping the legacy Confirmed path for the manual one-file workflow. `verified-repair-pr.mjs` titles and bodies name the failed bounded command as the verified target and label the model text as hypothesis.

Slice B added `services/proof-snapshots.mjs` (fingerprint plus byte hash) and made `local-artifact-service.mjs` own stable publication. Terminal GETs in `scripts/serve-web.mjs` use `getOrPublish`. Unchanged reads return the cached descriptor without touching the filesystem. Changed repair or browser input publishes fresh bytes, so the HMAC-bound approval goes stale by digest mismatch. Per-run locks stop concurrent readers from interleaving deletes and writes. Downloads hash actual bytes against the manifest and reject tampered content.

Slice C reworked only `renderMasterAudit` in `apps/web/index.html` plus narrow overflow CSS. Summary, hypothesis, executed check, browser fixture, repair, proof and cleanup are separate cards. Stdout and stderr show char and line counts in bounded wrapping blocks. Cleanup names missing fields. Artifacts show Present and Missing with labelled SHA-256 and download links only when Present. Browser keeps fixture-only wording with expandable console and network rows that preserve unknown keys.

## Controlled fixtures vs real acceptance

New tests use controlled fixtures: stubbed model findings, fixture commands, temp-dir bundles and synthetic screenshots. They prove composition, stability, tamper rejection and rendering. They do not replace Docker, browser or live-model acceptance. The parent performs actual browser and live model and Docker verification separately. No browser, Docker run or long-lived app was started here. Existing automated tests use short-lived servers only.

## Limits

One in-process lock per run. Memory cache capped at 30 descriptors. No cross-process snapshot coordination. No new datastore. Existing redaction, ownership, path, approval and remote-byte gates unchanged.
