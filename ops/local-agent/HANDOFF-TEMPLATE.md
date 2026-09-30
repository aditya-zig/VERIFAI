# Handoff

Copy this template when leaving a handoff. Keep it factual and short.
GitHub + the checkout outrank memory and old chats.

```text
Issue:
Branch:
PR:

Done (files + behavior):

Tests (exact commands + counts):
- npm run ops:test → __/__ PASS
- RED confirmed: __ tests / __ failures before GREEN
- bash -n on touched scripts → clean

Manual verification (commands + observed output):

RAM / resource notes:

Blocked (exact error + likely cause, or "none"):

Exact next step:

Restart commands:
- git status --short --branch
- npm run ops:test
```

Rules: no secrets in the handoff (sentinel `VERIFAI_TEST_SECRET_123`
is the test fixture only); no `package-lock.json` in commits; humans merge.
