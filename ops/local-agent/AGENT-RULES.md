# Agent rules

Operational rules for every coding agent working on VERIFAI.

1. **One issue at a time.** One issue → one branch → RED → smallest GREEN → verification → PR.
2. **Remote agent writes; local agent proves.** Remote implementation workers push code/tests through GitHub. Before coding locally, check for existing remote work, pull it, and make the laptop the final runtime truth gate. Do not duplicate remote implementation without executed evidence of a defect. See [`REMOTE-LOCAL-WORKFLOW.md`](REMOTE-LOCAL-WORKFLOW.md).
3. **No unrelated refactors.** No dependency upgrades or architecture redesigns outside the assigned issue.
4. **TDD where appropriate:** failing test → confirm RED → smallest implementation → GREEN. Confirm RED before implementing.
5. **Tests alone do not equal Done.** Passing tests are evidence, not completion.
6. **Manual browser/product verification is required when the behavior is user-visible.**
7. **No mocked or synthetic findings in real acceptance paths.** No fake engine output, fake screenshots, fake PASS states.
8. **Missing capability = Incomplete / Unknown. Never invent PASS.** Evidence beats model claims.
9. **Remote proof must stay truthful.** A remote agent must not claim local browser, Docker, model/provider, RAM, process-cleanup, or hardware-specific PASS unless it actually executed that proof.
10. **Humans approve merges.** Never auto-merge.
11. **Never expose secrets.** Never print, commit, paste, or log API keys or other secret values.
12. **8 GB machine:** one heavy process/model/agent at a time; keep the laptop responsive.
13. **No Ollama.** API-backed models only.
14. **No Docker before M4** (#10) unless the assigned issue explicitly changes that rule.
15. **No AWS, TrueForge, or software-factory expansion ahead of the roadmap** (software factory blocked behind reliable M5, #11).
16. **After two evidence-backed attempts at the same blocker:** stop retrying and report — attempted, exact failure, evidence, likely cause, smallest next action.
17. **If the master E2E breaks:** stop feature work until it is fixed.
