#!/usr/bin/env bash
# VERIFAI local-agent verify runner (LA5) — honest per-check verification.
# Runs ONLY the checks available in the current checkout: each check inspects
# package.json at runtime and reports PASS / FAIL / SKIPPED WITH REASON.
# Never claims PASS for a command that was not executed successfully.
# Read-only outside kit-owned paths; never prints secret values.
set -u

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
usage() { printf '%s\n' "usage: verify-local.sh" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then err "verify-local: git is unavailable"; exit 1; fi
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then err "verify-local: not inside a Git repository"; exit 1; fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
kit_scripts="preflight.sh check-docker.sh doctor.sh start-local.sh stop-local.sh cleanup-local.sh verify-local.sh"

# Runtime inspection: does package.json declare this npm script?
has_npm_script() {
  node -e 'const p = require(process.argv[1]); process.exit(p.scripts && p.scripts[process.argv[2]] ? 0 : 1)' \
    "${repo_root}/package.json" "$1" 2>/dev/null
}

# VERIFY_ONLY limits the run to a comma-separated subset:
# syntax, opstest, typecheck, e2e. Unknown names are a usage error.
want() {
  case ",${VERIFY_ONLY:-}," in
    ",,"|*",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "${VERIFY_ONLY:-}" ]; then
  only="${VERIFY_ONLY:-}"
  for name in $(printf '%s' "${only}" | tr ',' ' '); do
    case "${name}" in
      syntax|opstest|typecheck|e2e) ;;
      *) err "verify-local: unknown check '${name}' (expected syntax, opstest, typecheck, e2e)"; exit 2 ;;
    esac
  done
fi

pass_count=0
fail_count=0
skip_count=0

report_pass() { say "$1: PASS"; pass_count=$((pass_count + 1)); }
report_fail() { say "$1: FAIL ($2)"; fail_count=$((fail_count + 1)); }
report_skip() { say "$1: SKIPPED WITH REASON: $2"; skip_count=$((skip_count + 1)); }

# --- 1) shell syntax over kit scripts ---------------------------------------
if want syntax; then
  syntax_ok=1
  for s in ${kit_scripts}; do
    if [ -f "${script_dir}/${s}" ]; then
      if bash -n "${script_dir}/${s}" 2>/dev/null; then
        say "syntax ${s}: ok"
      else
        say "syntax ${s}: SYNTAX ERROR"
        syntax_ok=0
      fi
    else
      say "syntax ${s}: missing file"
      syntax_ok=0
    fi
  done
  if [ "${syntax_ok}" -eq 1 ]; then
    report_pass "syntax"
  else
    report_fail "syntax" "bash -n reported an error"
  fi
fi

# --- 2) kit safety tests -----------------------------------------------------
if want opstest; then
  if has_npm_script "ops:test"; then
    if (set -o pipefail; cd "${repo_root}" && npm run ops:test 2>&1 | tail -8); then
      report_pass "ops:test"
    else
      report_fail "ops:test" "npm run ops:test exited non-zero"
    fi
  else
    report_skip "ops:test" "npm script 'ops:test' is not present in this checkout"
  fi
fi

# --- 3) typecheck ------------------------------------------------------------
if want typecheck; then
  if has_npm_script "typecheck"; then
    if (set -o pipefail; cd "${repo_root}" && npm run typecheck 2>&1 | tail -5); then
      report_pass "typecheck"
    else
      report_fail "typecheck" "npm run typecheck exited non-zero"
    fi
  else
    report_skip "typecheck" "npm script 'typecheck' is not present in this checkout"
  fi
fi

# --- 4) local end-to-end -----------------------------------------------------
if want e2e; then
  if has_npm_script "test:local-e2e"; then
    if (set -o pipefail; cd "${repo_root}" && npm run test:local-e2e 2>&1 | tail -8); then
      report_pass "test:local-e2e"
    else
      report_fail "test:local-e2e" "npm run test:local-e2e exited non-zero"
    fi
  else
    report_skip "test:local-e2e" "npm script 'test:local-e2e' is not present in this checkout"
  fi
fi

say "summary: ${pass_count} passed, ${fail_count} failed, ${skip_count} skipped"
if [ "${fail_count}" -gt 0 ]; then
  say "result: FAIL"
  exit 1
fi
say "result: PASS (with ${skip_count} skipped)"
exit 0
