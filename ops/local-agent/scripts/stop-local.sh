#!/usr/bin/env bash
# VERIFAI local-agent stop (LA3) — stops ONLY kit-owned processes after full
# identity verification (PID + start time + cwd + command). Signals only the
# recorded process group. Idempotent: running twice is safe.
set -u

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
usage() { printf '%s\n' "usage: stop-local.sh" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then err "stop-local: git is unavailable"; exit 1; fi
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then err "stop-local: not inside a Git repository"; exit 1; fi

# Same ownership id algorithm as check-docker.sh (LA1).
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(printf '%s' "${repo_root}" | sha256sum | awk '{print substr($1, 1, 12)}')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(printf '%s' "${repo_root}" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
else
  digest="$(printf '%s' "${repo_root}" | cksum | awk '{printf "%012d", $1}')"
fi
owner_id="vagent.${digest}"
state_dir="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-${owner_id}"

pid_alive() { kill -0 "$1" 2>/dev/null; }

norm() { printf '%s' "$1" | sed 's/  */ /g; s/^ //; s/ $//'; }

stopped_any=0
refused=0

stop_one() { # $1=state file
  state_file="$1"
  svc="$(grep -m1 '^service=' "${state_file}" | cut -d= -f2-)"
  pid="$(grep -m1 '^pid=' "${state_file}" | cut -d= -f2-)"
  want_start="$(grep -m1 '^start_time=' "${state_file}" | cut -d= -f2-)"
  want_cwd="$(grep -m1 '^cwd=' "${state_file}" | cut -d= -f2-)"
  want_cmd="$(grep -m1 '^command=' "${state_file}" | cut -d= -f2-)"
  pgid="$(grep -m1 '^pgid=' "${state_file}" | cut -d= -f2-)"

  if ! pid_alive "${pid}"; then
    say "${svc}: recorded process is gone; reconciling as Crashed"
    {
      printf 'service=%s\n' "${svc}"
      printf 'pid=%s\n' "${pid}"
      printf 'status=Crashed\n'
      printf 'reason=owned process disappeared before stop\n'
    } > "${state_dir}/${svc}.exit"
    rm -f "${state_file}"
    return 0
  fi

  # Full identity verification before ANY signal.
  got_start="$(ps -o lstart= -p "${pid}" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ "$(norm "${got_start}")" != "$(norm "${want_start}")" ]; then
    err "${svc}: REFUSED — start time mismatch for pid ${pid} (recorded '${want_start}' vs actual '${got_start}')"
    refused=1
    return 1
  fi

  got_cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [ -n "${want_cwd}" ] && [ "${got_cwd}" != "${want_cwd}" ]; then
    err "${svc}: REFUSED — cwd mismatch for pid ${pid} (recorded '${want_cwd}' vs actual '${got_cwd}')"
    refused=1
    return 1
  fi

  got_cmd="$(ps -o args= -p "${pid}" 2>/dev/null | sed 's/^ *//;s/ *$//' | head -c 400)"
  if [ "$(norm "${got_cmd}")" != "$(norm "${want_cmd}")" ]; then
    err "${svc}: REFUSED — command mismatch for pid ${pid} (recorded '${want_cmd}' vs actual '${got_cmd}')"
    refused=1
    return 1
  fi

  # Verified: signal only the recorded process group (npm parent + node child).
  if [ -n "${pgid}" ] && [ "${pgid}" -gt 1 ] 2>/dev/null; then
    say "${svc}: verified pid ${pid}; stopping process group ${pgid}"
    kill -TERM -- "-${pgid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null
  else
    say "${svc}: verified pid ${pid}; stopping process"
    kill -TERM "${pid}" 2>/dev/null
  fi

  for _ in $(seq 1 50); do
    pid_alive "${pid}" || break
    sleep 0.2
  done
  if pid_alive "${pid}"; then
    err "${svc}: still Running after bounded TERM grace; no force kill attempted"
    refused=1
    return 1
  fi

  {
    printf 'service=%s\n' "${svc}"
    printf 'pid=%s\n' "${pid}"
    printf 'status=Stopped\n'
    printf 'reason=verified graceful stop\n'
  } > "${state_dir}/${svc}.exit"
  rm -f "${state_file}"
  stopped_any=1
  say "${svc}: Stopped (pid ${pid})"
  return 0
}

if [ ! -d "${state_dir}" ]; then
  say "nothing to stop (no kit state at ${state_dir})"
  say "result: already stopped"
  exit 0
fi

shopt -s nullglob
state_files=("${state_dir}"/*.state)
shopt -u nullglob
if [ "${#state_files[@]}" -eq 0 ]; then
  say "nothing to stop (no state files at ${state_dir})"
  say "result: already stopped"
  exit 0
fi

for f in "${state_files[@]}"; do
  stop_one "${f}" || true
done

if [ "${refused}" -eq 1 ]; then
  err "one or more services were REFUSED or remained Running; no unrelated process was signalled"
  exit 1
fi
if [ "${stopped_any}" -eq 1 ]; then
  say "result: stopped"
else
  say "result: already stopped"
fi
exit 0
