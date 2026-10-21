# Dockerfile path safety

Issue #83, checked 21 October 2026 against main `b88775d`.

The buildspec generator defaults an omitted `dockerfile` to `Dockerfile`.
An explicit value must be a nonempty string of at most 256 ASCII characters,
with repository-relative components separated by `/`. Each component must start
with a letter, digit or underscore; later characters may also be dots or hyphens.
Values are not trimmed: empty strings, whitespace, shell syntax, control
characters, absolute paths, traversal and empty components are rejected with an
`AwsTargetLifecycleError` in the `build` phase before `StartBuild` or any other
cloud call from `AwsTargetLifecycle.start`.

The generated build checks that the Dockerfile is tracked and regular, and that
neither the file nor any parent component is a symlink. A failed check exits 42
with a `VERIFIAI_UNSUPPORTED` diagnostic before `docker build`. Diagnostics and
Docker arguments quote the accepted path. The guard is a JSON-quoted YAML scalar
so its diagnostic colon cannot change the buildspec structure.

## Verification

- Baseline lifecycle tests passed, 4 tests.
- New regression tests failed before the fix, 18 unsafe paths reached the mocked
  cloud client instead of being rejected.
- After the fix, 24 targeted tests passed. The generated guard executed against
  an actual temporary Git repository and rejected missing, untracked, directory
  and symlink paths.
- `npm run check` passed, including policy, typecheck, compiled tests, P0, P1
  and the fixture demo.
- `npm run ops:test` passed, 59 tests.

No AWS resources, real builds, paid inference or candidate applications ran.
These checks prove path handling, not sandbox isolation or cloud acceptance.
A tracked Dockerfile can still execute malicious build instructions. Arbitrary
untrusted candidate builds must remain outside credentialed builders until the
separate executor and trusted publisher described in PR #80 are implemented.
