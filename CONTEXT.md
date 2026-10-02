# CONTEXT — settled domain terms

Source: VERIFAI — Grill with Docs (Notion, last edited 2026-10-01 08:55 UTC). Titles cited, not bare ADR numbers. Glossary only.

- model hypothesis: the single AI-written title, description, severity and file reference. Opinion only. Never verification on its own. Confidence stays Unconfirmed.
- executed check: the one bounded server-selected command run in the Docker sandbox, with command, exit code, stdout, stderr, duration and sandbox facts. Server-owned.
- finding confidence: Unconfirmed for the allegation after any single limited check, pass or fail. Incomplete when the check did not run, timed out, aborted, or facts disagree. Unknown when evidence is missing.
- reproduction/replay coverage: SAME-COMMAND REPLAY with limited coverage. The repair path reruns the same bounded command before, after and as regressions. Not independent regression breadth. Never a test suite, security or compatibility claim.
- proof snapshot: the published bundle for a terminal run, with manifest digest, Present and Missing artifacts, and server-owned bytes. Unchanged terminal reads return the same descriptor without rewriting. Changed repair or browser evidence publishes a fresh descriptor and makes prior approval stale.
- verified repair: before executed failure plus after executed success plus replay checks, exact patch and file digests, base commit provenance, unchanged original tree and cleanup. The verified target is the failed bounded command. The model hypothesis stays labelled separately.
