# VERIFAI — coding-agent entry point

VERIFAI development is **local-first**.

**Fresh agents MUST read [`ops/local-agent/START-HERE.md`](ops/local-agent/START-HERE.md) before starting any task.**

**Primary workflow rule: remote agent writes; local agent proves.** Remote implementation workers push code/tests to GitHub; the laptop agent pulls first and supplies real runtime acceptance. Read [`ops/local-agent/REMOTE-LOCAL-WORKFLOW.md`](ops/local-agent/REMOTE-LOCAL-WORKFLOW.md).

Operating rules:

- GitHub is the implementation source of truth. Current issue/PR/CI state must be checked live — never from memory or an old chat.
- Before coding locally, check whether a remote PR already implements the milestone. Do not duplicate work without executed evidence of a defect.
- Work one issue at a time: issue → branch → RED → smallest GREEN → verification → PR.
- Evidence over AI opinion. Missing capability = Incomplete/Unknown; never invent PASS.
- Remote agents must not claim local browser/Docker/model/resource PASS unless they actually executed it.
- Humans approve merges. Never auto-merge.
- Do not start AWS, TrueForge, Docker, Ollama, or software-factory work unless the assigned roadmap issue explicitly requires it.
- Development machine has 8 GB RAM: API-backed models only, one heavy process at a time.

Kit index: [`ops/local-agent/README.md`](ops/local-agent/README.md). Historical/cloud docs remain elsewhere in the repo as migration debt, not as current direction.
