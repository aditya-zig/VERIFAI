# Agent rules

Operational rules for every coding agent working on VERIFAI.

1. **One issue at a time.** One issue → one branch → RED → smallest GREEN → verification → PR.
2. **No unrelated refactors.** No dependency upgrades or architecture redesigns outside the assigned issue.
3. **TDD where appropriate:** failing test → confirm RED → smallest implementation → GREEN. Confirm RED before implementing.
4. **Tests alone do not equal Done.** Passing tests are evidence, not completion.
5. **Manual browser/product verification is required when the behavior is user-visible.**
6. **No mocked or synthetic findings in real acceptance paths.** No fake engine output, fake screenshots, fake PASS states.
7. **Missing capability = Incomplete / Unknown. Never invent PASS.** Evidence beats model claims.
8. **Humans approve merges.** Never auto-merge.
9. **Never expose secrets.** Never print, commit, paste, or log API keys or other secret values.
10. **8 GB machine:** one heavy process/model/agent at a time; keep the laptop responsive.
11. **No Ollama.** API-backed models only.
12. **No Docker before M4** (#10) unless the assigned issue explicitly changes that rule.
13. **No AWS, TrueForge, or software-factory expansion ahead of the roadmap** (software factory blocked behind reliable M5, #11).
14. **After two evidence-backed attempts at the same blocker:** stop retrying and report — attempted, exact failure, evidence, likely cause, smallest next action.
15. **If the master E2E breaks:** stop feature work until it is fixed.
