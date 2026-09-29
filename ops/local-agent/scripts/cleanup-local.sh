#!/usr/bin/env bash
# VERIFAI local-agent cleanup (LA4) — removes ONLY proven kit-owned resources:
# the kit state directory, temp paths recorded by the kit and bounded inside
# the kit temp root, and exactly label-owned Docker containers. Never prunes,
# never selects Docker by broad name, never touches unrelated files/processes.
set -u

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
usage() { printf '%s\n' "usage: cleanup-local.sh" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then err "cleanup-local: git is unavailable"; exit 1; fi
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then err "cleanup-local: not inside a Git repository"; exit 1; fi

script_dir="$(cd "$(dirname "$0")" && pwd)"

# Same ownership id algorithm as check-docker.sh (LA1).
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(printf '%s' "${repo_root}" | sha256sum | awk '{print substr($1, 1, 12)}')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(printf '%s' "${repo_root}" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
else
  digest="$(printf '%s' "${repo_root}" | cksum | awk '{printf "%012d", $1}')"
fi
owner_id="vagent.${digest}"
kit_temp_root="${TMPDIR:-/tmp}"
state_dir="${kit_temp_root}/verifiai-local-agent-$(id -u)-${owner_id}"

say "verifai local-agent cleanup (read-only outside kit-owned paths)"
say "state: ${state_dir}"

# --- 1) safe stop first ----------------------------------------------------
if [ -x "${script_dir}/stop-local.sh" ]; then
  if ! "${script_dir}/stop-local.sh"; then
    err "cleanup-local: stop refused — refusing to delete anything"
    exit 1
  fi
else
  err "cleanup-local: stop-local.sh not found next to this script"
  exit 1
fi

# --- 2) recorded temp paths, bounded inside the kit temp root --------------
removed_paths=0
refused_paths=0
if [ -d "${state_dir}" ] && [ -f "${state_dir}/owned-paths.list" ]; then
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    # Bounds check: must be inside the kit temp root, and not the root itself.
    case "${p}" in
      "${kit_temp_root}"/*) ;;
      *)
        say "path ${p}: REFUSED (outside kit temp root ${kit_temp_root})"
        refused_paths=$((refused_paths + 1))
        continue
        ;;
    esac
    if [ -e "${p}" ]; then
      rm -rf -- "${p}"
      say "path ${p}: removed (recorded, kit-owned)"
      removed_paths=$((removed_paths + 1))
    else
      say "path ${p}: absent (nothing to remove)"
    fi
  done < "${state_dir}/owned-paths.list"
else
  say "recorded paths: none"
fi

# --- 3) exact label-owned Docker containers (informational when absent) -----
if ! command -v docker >/dev/null 2>&1; then
  say "docker: not installed (informational, nothing to clean)"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  say "docker: daemon unavailable (informational, nothing to clean)"
else
  owned_containers="$(docker container ls -q --filter "label=dev.verifiai.local-agent.owner=${owner_id}" 2>/dev/null || true)"
  owned_all="$(docker container ls -aq --filter "label=dev.verifiai.local-agent.owner=${owner_id}" 2>/dev/null || true)"
  running_count=0
  all_count=0
  [ -n "${owned_containers}" ] && running_count="$(printf '%s\n' "${owned_containers}" | grep -c . || true)"
  [ -n "${owned_all}" ] && all_count="$(printf '%s\n' "${owned_all}" | grep -c . || true)"
  say "docker: label-owned running containers: ${running_count}"
  say "docker: label-owned containers (all states): ${all_count}"
  if [ "${running_count}" -gt 0 ]; then
    say "docker: report-only — remove kit containers explicitly by id: ${owned_containers//$'\n'/,}"
  else
    say "docker: nothing kit-owned to remove"
  fi
fi

# --- 4) kit state directory (bounded by exact name) ------------------------
if [ -d "${state_dir}" ]; then
  expected_name="verifiai-local-agent-$(id -u)-${owner_id}"
  actual_name="$(basename "${state_dir}")"
  if [ "${actual_name}" = "${expected_name}" ] && [ "$(dirname "${state_dir}")" = "${kit_temp_root}" ]; then
    rm -rf -- "${state_dir}"
    say "state dir: removed"
  else
    err "state dir: REFUSED (name/parent mismatch) — not deleting"
    exit 1
  fi
else
  say "state dir: already absent"
fi

say "summary: recorded paths removed ${removed_paths}, refused ${refused_paths}"
say "result: cleaned"
exit 0
