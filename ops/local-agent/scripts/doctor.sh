#!/usr/bin/env bash
# VERIFAI local-agent doctor (LA2) — READ ONLY staged readiness check.
# Usage: doctor.sh --stage M1 | --stage M2
# Prints variable names and presence only. Never prints secret values.
set -u

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  printf '%s\n' "usage: doctor.sh --stage M1|M2" >&2
}

stage=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage)
      shift
      [ $# -gt 0 ] || { usage; exit 1; }
      stage="$1"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
  shift
done

case "${stage}" in
  M1|M2) ;;
  *) usage; exit 1 ;;
esac

say "verifai local-agent doctor (read-only)"
say "stage: ${stage}"

# --- shared prerequisites (both stages) -----------------------------------
if ! command -v git >/dev/null 2>&1; then
  fail "doctor: git is unavailable"
fi
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then
  fail "doctor: not inside a Git repository"
fi

remote_url="$(git -C "${repo_root}" remote get-url origin 2>/dev/null || true)"
case "${remote_url}" in
  *aditya-zig/VERIFAI*) say "repo: canonical (aditya-zig/VERIFAI)" ;;
  "") say "repo: WARN no origin remote" ;;
  *) say "repo: WARN non-canonical" ;;
esac

node_version="$(node --version 2>/dev/null || true)"
if [ -z "${node_version}" ]; then
  say "node: FAIL not installed"
  exit 1
fi
node_major="$(printf '%s' "${node_version}" | sed 's/^v//' | cut -d. -f1)"
if [ "${node_major}" -ge 18 ] 2>/dev/null; then
  say "node: OK ${node_version}"
else
  say "node: FAIL ${node_version} (need >= 18)"
  exit 1
fi

npm_version="$(npm --version 2>/dev/null || true)"
if [ -n "${npm_version}" ]; then
  say "npm: OK ${npm_version}"
else
  say "npm: FAIL not available"
  exit 1
fi

if [ -d "${repo_root}/node_modules" ]; then
  say "node_modules: OK installed"
else
  say "node_modules: WARN missing (run npm install)"
fi

# ports (informational for doctor; start/stop handles ownership later)
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

# RAM / disk warnings (never invented: unknown when utility missing)
if command -v free >/dev/null 2>&1; then
  avail_kb="$(free -m 2>/dev/null | awk '/^Mem:/ && $7 != "" {print $7 * 1024}')"
  if [ -n "${avail_kb}" ]; then
    if [ "${avail_kb}" -lt 1048576 ]; then
      say "ram: WARN ${avail_kb} KB available (< 1 GB)"
    else
      say "ram: OK ${avail_kb} KB available"
    fi
  else
    say "ram: unknown"
  fi
elif command -v vm_stat >/dev/null 2>&1; then
  free_pages="$(vm_stat 2>/dev/null | awk '/^Pages free:/ {gsub(/\./, "", $3); print $3}')"
  if [ -n "${free_pages}" ]; then
    say "ram: OK ${free_pages} pages free"
  else
    say "ram: unknown"
  fi
else
  say "ram: unknown"
fi

free_kb="$(df -Pk "${repo_root}" 2>/dev/null | awk 'END {print $4}')"
if [ -n "${free_kb}" ]; then
  if [ "${free_kb}" -lt 20971520 ]; then
    say "disk: WARN ${free_kb} KB free (< 20 GB; heavy Docker/M4 work deferred)"
  else
    say "disk: OK ${free_kb} KB free"
  fi
else
  say "disk: unknown"
fi

# docker: informational only for both stages (deferred to M4)
if command -v docker >/dev/null 2>&1; then
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    say "docker: INFO installed, daemon running (not required for M1/M2)"
  else
    say "docker: INFO installed, daemon unavailable (not required for M1/M2)"
  fi
else
  say "docker: INFO not installed (not required for M1/M2)"
fi

# --- M1 has no model key requirement ---------------------------------------
if [ "${stage}" = "M1" ]; then
  say "model provider: not required for M1"
  say "result: PASS"
  exit 0
fi

# --- M2: AWS Bedrock configuration, presence only --------------------------
# AWS SDK resolves credentials (profile/SSO, temporary environment keys, or
# execution role). This read-only check never calls AWS or proves model access.
present() { [ -n "${1//[[:space:]]/}" ]; }
provider="${VERIFIAI_MODEL_PROVIDER:-bedrock}"
if [ "${provider}" != "bedrock" ]; then
  say "model provider: FAIL unsupported provider (only bedrock is supported)"
  say "result: FAIL"
  exit 1
fi
say "model provider: bedrock"
ready=1
if present "${VERIFIAI_BEDROCK_MODEL_ID:-${VERIFIAI_MODEL_ID:-}}"; then
  say "VERIFIAI_BEDROCK_MODEL_ID / VERIFIAI_MODEL_ID: present"
else
  say "VERIFIAI_BEDROCK_MODEL_ID / VERIFIAI_MODEL_ID: missing (set a model or inference profile ID)"
  ready=0
fi
if present "${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"; then
  say "AWS_REGION / AWS_DEFAULT_REGION: present"
else
  say "AWS_REGION / AWS_DEFAULT_REGION: missing"
  ready=0
fi

# Check configured credential sources without reading or printing their values.
if present "${AWS_BEARER_TOKEN_BEDROCK:-}"; then
  say "AWS_BEARER_TOKEN_BEDROCK: present"
elif present "${AWS_ACCESS_KEY_ID:-}" && present "${AWS_SECRET_ACCESS_KEY:-}"; then
  say "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY: present"
  if present "${AWS_SESSION_TOKEN:-}"; then say "AWS_SESSION_TOKEN: present"; fi
elif present "${AWS_PROFILE:-}"; then
  say "AWS_PROFILE: present (profile/SSO resolution is delegated to the AWS SDK)"
elif [ -r "${AWS_SHARED_CREDENTIALS_FILE:-${HOME:-}/.aws/credentials}" ] || \
     [ -r "${AWS_CONFIG_FILE:-${HOME:-}/.aws/config}" ]; then
  say "AWS shared credentials/config file: present"
elif present "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" || present "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}"; then
  say "AWS container execution-role credential source: present"
elif present "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" && present "${AWS_ROLE_ARN:-}"; then
  say "AWS web-identity credential source: present"
else
  say "AWS credentials: missing (configure a profile/SSO, shared AWS file, temporary access-key pair, Bedrock bearer token, or execution-role source)"
  ready=0
fi
say "readiness: presence only; not proof of live AWS access, model permission, or unexpired credentials"
if [ "${ready}" -eq 1 ]; then
  say "result: PASS (configuration presence only)"
  exit 0
fi
say "result: FAIL"
exit 1
