# Dockerfile path safety

Issue #83, checked 21 October 2026 against main `b88775d`.

The buildspec generator rejects shell syntax, control characters, absolute paths,
traversal, empty components and leading option characters before `StartBuild`.
An omitted path still selects `Dockerfile`. Accepted paths are at most 256
characters and use repository-relative components containing letters, digits,
underscores, dots and hyphens.

The generated build checks that the Dockerfile is tracked and regular, and that
neither the file nor any parent component is a symlink. Diagnostics and Docker
arguments quote the accepted path. The guard is a JSON-quoted YAML scalar so its
diagnostic colon cannot change the buildspec structure.

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
