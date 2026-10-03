#!/usr/bin/env bash
# VERIFAI local-agent preflight (LA1) — READ ONLY environment report.
# Prints variable names and presence only. Never prints secret values.
# Performs no writes, no installs, no process changes.
set -u

say() { printf '%s\n' "$*"; }

say "verifai local-agent preflight (read-only)"

if ! command -v git >/dev/null 2>&1; then
  printf '%s\n' "preflight: git is unavailable" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then
  printf '%s\n' "preflight: not inside a Git repository" >&2
  exit 1
fi

remote_url="$(git -C "${repo_root}" remote get-url origin 2>/dev/null || true)"
case "${remote_url}" in
  *aditya-zig/VERIFAI*) say "repo: canonical (aditya-zig/VERIFAI)" ;;
  "") say "repo: no origin remote" ;;
  *) say "repo: non-canonical" ;;
esac

say "root: ${repo_root}"

branch="$(git -C "${repo_root}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
say "branch: ${branch:-unknown}"

dirty_count="$(git -C "${repo_root}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [ "${dirty_count}" = "0" ]; then
  say "worktree: clean"
else
  say "worktree: dirty (${dirty_count} changes)"
fi

commit="$(git -C "${repo_root}" rev-parse --short HEAD 2>/dev/null || true)"
say "commit: ${commit:-unknown}"

node_version="$(node --version 2>/dev/null || true)"
say "node: ${node_version:-unknown}"

npm_version="$(npm --version 2>/dev/null || true)"
say "npm: ${npm_version:-unknown}"

# RAM: Linux via free, macOS via vm_stat + sysctl; unknown when neither exists.
if command -v free >/dev/null 2>&1; then
  ram="$(free -m 2>/dev/null | awk '/^Mem:/ && $7 != "" {printf "%d MB total, %d MB available", $2, $7}')"
  say "ram: ${ram:-unknown}"
elif command -v vm_stat >/dev/null 2>&1 && command -v sysctl >/dev/null 2>&1; then
  total_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  page_size="$(vm_stat 2>/dev/null | awk -F'page size of ' 'NR == 1 {split($2, a, " "); print a[1]}')"
  free_pages="$(vm_stat 2>/dev/null | awk '/^Pages free:/ {gsub(/\./, "", $3); print $3}')"
  if [ -n "${total_bytes}" ] && [ -n "${page_size}" ] && [ -n "${free_pages}" ]; then
    ram="$(awk -v t="${total_bytes}" -v s="${page_size}" -v p="${free_pages}" 'BEGIN {printf "%d MB total, %d MB available", t / 1048576, p * s / 1048576}')"
    say "ram: ${ram}"
  else
    say "ram: unknown"
  fi
else
  say "ram: unknown"
fi

free_kb="$(df -Pk "${repo_root}" 2>/dev/null | awk 'END {print $4}')"
if [ -n "${free_kb}" ]; then
  disk="$(awk -v k="${free_kb}" 'BEGIN {printf "%d GB available", k / 1048576}')"
  say "disk: ${disk}"
else
  say "disk: unknown"
fi

# Docker is deferred to M4: report only, never a failure.
if command -v docker >/dev/null 2>&1; then
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    say "docker: installed, daemon running"
  else
    say "docker: installed, daemon unavailable"
  fi
else
  say "docker: not installed"
fi

report_port() {
  port="$1"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      say "port ${port}: listening"
    else
      say "port ${port}: free"
    fi
  elif command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk 'NR > 1 {print $4}' | grep -q ":${port}\$"; then
      say "port ${port}: listening"
    else
      say "port ${port}: free"
    fi
  else
    say "port ${port}: unknown"
  fi
}

report_port 4173
report_port 8787

# Environment presence only — names, never values.
for name in VERIFIAI_MODEL_PROVIDER VERIFIAI_BEDROCK_MODEL_ID VERIFIAI_MODEL_ID \
  AWS_REGION AWS_DEFAULT_REGION AWS_PROFILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_BEARER_TOKEN_BEDROCK \
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN VERIFIAI_RUN_AWS_E2E VERIFIAI_STATE_SECRET \
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  if [ -n "$(printenv "${name}" 2>/dev/null || true)" ]; then
    say "${name}: present"
  else
    say "${name}: absent"
  fi
done

exit 0
