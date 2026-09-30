#!/usr/bin/env bash
# VERIFAI local-agent docker inspection (LA1) — READ ONLY.
# Informational only: Docker is deferred to M4 and is never required here.
# Inspects kit-owned containers by ownership label. Changes nothing.
set -u

say() { printf '%s\n' "$*"; }

# Ownership id: deterministic, derived from the checkout root.
# Shared LA1 algorithm: later kit scripts must reuse this same derivation
# for ownership labels and kit state, and must not hardcode absolute paths.
kit_owner_id() {
  root_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "${root_path}" | sha256sum | awk '{print substr($1, 1, 12)}')"
  elif command -v shasum >/dev/null 2>&1; then
    digest="$(printf '%s' "${root_path}" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
  else
    digest="$(printf '%s' "${root_path}" | cksum | awk '{printf "%012d", $1}')"
  fi
  printf 'vagent.%s' "${digest}"
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then
  repo_root="$(pwd -P)"
fi

owner_id="$(kit_owner_id "${repo_root}")"
owner_label="dev.verifiai.local-agent.owner=${owner_id}"
say "owner-label: ${owner_label}"

if ! command -v docker >/dev/null 2>&1; then
  say "docker: not installed (informational, deferred to M4)"
  exit 0
fi

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  say "docker: daemon unavailable (informational, deferred to M4)"
  exit 0
fi

say "docker: available"
say "scope: kit-owned containers only (${owner_label})"

count=0
while IFS= read -r container_name; do
  [ -n "${container_name}" ] || continue
  count=$((count + 1))
  say "container: ${container_name}"
done < <(docker ps --all --filter "label=${owner_label}" --format '{{.Names}}' 2>/dev/null)
say "kit-owned containers: ${count}"
exit 0
