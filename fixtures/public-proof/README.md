# VERIFAI public-proof fixture

Deterministic, dependency-free fixture template for the final public repair proof.

The broken state is intentional. Do not publish a separate repository from this template without explicit human authorization.

## Broken default

VERIFAI's bounded command selector reads `package.json` and selects:

```bash
node --check broken.mjs
```

Expected BEFORE result: non-zero exit caused by the deliberate extra `}`.

## Exact valid repair

In `broken.mjs`, replace the final:

```text
}}
```

with:

```text
}
```

Expected AFTER result: exit 0.

M8 reruns the same bounded verification as its regression check, so regression must also exit 0.

The original base repository must remain unchanged. VERIFAI may create only a repair branch and pull request. No auto-merge.
