# VERIFAI public-proof fixture

Deterministic, dependency-free fixture template for the final public repair proof.

The broken state is intentional. Do not publish a separate repository from this template without explicit human authorization.

## Broken default

```bash
node --test fixtures/public-proof/before.test.mjs
```

Expected: non-zero exit.

## Regression

```bash
node --test fixtures/public-proof/regression.test.mjs
```

Expected: zero exit before and after repair.

## Exact valid repair

In `is-even.mjs`, replace:

```js
return value % 2 === 1;
```

with:

```js
return value % 2 === 0;
```

Then rerun both commands. The main test must exit 0 and the regression must remain 0.

The original base repository must remain unchanged. VERIFAI may create only a repair branch and pull request. No auto-merge.
