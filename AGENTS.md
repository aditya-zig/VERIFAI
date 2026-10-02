# VERIFAI — coding-agent entry point

VERIFAI development is **local-first**.

**Fresh agents MUST read [`ops/local-agent/START-HERE.md`](ops/local-agent/START-HERE.md) before starting any task.**

Operating rules:

- GitHub is the implementation source of truth. Current issue/PR/CI state must be checked live — never from memory or an old chat.
- Work one issue at a time: issue → branch → RED → smallest GREEN → verification → PR.
- Evidence over AI opinion. Missing capability = Incomplete/Unknown; never invent PASS.
- Humans approve merges. Never auto-merge.
- Do not start AWS, TrueForge, Docker, Ollama, or software-factory work unless the assigned roadmap issue explicitly requires it.
- Development machine has 8 GB RAM: API-backed models only, one heavy process at a time.

Kit index: [`ops/local-agent/README.md`](ops/local-agent/README.md). Historical/cloud docs remain elsewhere in the repo as migration debt, not as current direction.

