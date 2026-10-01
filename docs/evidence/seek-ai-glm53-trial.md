# Seek AI / GLM 5.3 Flash trial — 2026-09-30

Status: **BLOCKED on provider routing; no GLM master E2E PASS**.

Canonical checkout: AWS-wemake/VERIFAI, branch `m5-master-local-e2e`, published
HEAD `2f2daa7` plus local uncommitted provider/configuration changes. No merges,
cloud resources, local model downloads, or desktop input were used for these trials.

## Observed evidence

- The user's supplied gateway is `https://seekai.cc`; API base is
  `https://seekai.cc/v1`. An authenticated models request returned HTTP 200 and
  listed the exact ID `glm-5.3-flash`. Credentials and headers are not recorded.
- Two real headless-browser UI submissions audited
  `https://github.com/jonschlinkert/is-number`. Each cloned 15 tracked files.
  At the existing 500-token cap, analysis failed with `Model did not return
  JSON`. A single trial at 1500 tokens hit the existing 60-second model timeout.
  Both were Incomplete, skipped execution, completed cleanup, and left no owned
  clone/container resources. The speculative cap increase was reverted.
- After renewed user authorization to continue, two tiny tool-free JSON-format
  diagnostics requested `glm-5.3-flash`, `reasoning_effort: low`, enabled thinking,
  JSON object mode, and a 500-token cap, with the same 60-second deadline.
  These were diagnostics, not repository acceptance or findings.
- First diagnostic: HTTP 200, 41000 ms, finish reason `stop`, 52 prompt tokens,
  85 completion tokens, expected JSON shape absent, returned model did not
  exactly match the request. The actual model name was not retained then.
- Second diagnostic: HTTP 200, 2357 ms, finish reason `stop`, 52 prompt tokens,
  85 completion tokens; reported model **`MiniMaxAI/MiniMax-M2.7`**. Content
  included an inline thinking block before the JSON answer, so the whole
  content was not JSON. No raw reasoning text is retained here.

The latter response is not a token-limit termination. Provider model substitution
is the confirmed current blocker. The original UI failures' raw responses were
not retained, so their exact causes are not independently established.
A model catalog entry does not prove the requested model was served. No claim
about actual model weights or monetary cost is made from these observations.

## Scoped safety change

`services/local-analysis.mjs` now rejects Seek AI GLM responses whose reported
model is missing or differs from `glm-5.3-flash` (case-insensitive), before parsing
or attaching findings. The error is constant text: it does not echo arbitrary
provider metadata or credentials. No automatic retry or model fallback is added.
The existing 500-token cap, 60-second model deadline, strict finding validation,
and other providers are unchanged.

A unit-only regression initially failed with `Missing expected rejection` when
valid finding JSON was returned under a different model identity. Configuration
and identity tests cover wrong/missing identity, secret-like metadata without
error reflection, matching identities, unchanged default provider, and strict
JSON rejection. Synthetic unit responses are not real audit evidence.

## Primary references

- [GLM 5.3 Flash model guide](https://docs.z.ai/guides/vlm/glm-5.3-flash.md)
- [Thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode.md): GLM 5.3
  Flash requires thinking; disabling it is not supported.
- [Deep thinking](https://docs.z.ai/guides/capabilities/thinking.md): supported
  efforts are `max`, `high`, and `low`; default is `max`.
- [Structured output](https://docs.z.ai/guides/capabilities/struct-output.md): JSON
  mode is `response_format: {type: json_object}` with explicit instructions.

These are upstream Z.AI semantics, not proof that Seek AI honors them.

## Smallest next action

Ask Seek AI support to verify/correct this key's channel/model mapping: requests
for `glm-5.3-flash` report `MiniMaxAI/MiniMax-M2.7`. Do not transmit the key in a
support message. Once mapping is corrected, verify reported GLM identity and JSON
with one bounded probe, then repeat one real UI audit with cleanup. Do not switch
to MiniMax, relax identity validation, raise all deadlines, or claim GLM success.
Rotate the credential disclosed in chat. No secret value, prefix, authentication
header, environment dump, or raw provider trace belongs in shareable evidence.
