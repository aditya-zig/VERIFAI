#!/usr/bin/env bash
# VERIFAI local-agent start (LA3) — starts ONLY kit-owned local services
# using the repository's own npm scripts. Refuses occupied ports instead of
# killing their owners. Records identity-rich state for safe stop/cleanup.
set -u

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
usage() { printf '%s\n' "usage: start-local.sh" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then err "start-local: git is unavailable"; exit 1; fi
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then err "start-local: not inside a Git repository"; exit 1; fi

# Same ownership id algorithm as check-docker.sh (LA1) — reuse, never hardcode.
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(printf '%s' "${repo_root}" | sha256sum | awk '{print substr($1, 1, 12)}')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(printf '%s' "${repo_root}" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
else
  digest="$(printf '%s' "${repo_root}" | cksum | awk '{printf "%012d", $1}')"
fi
owner_id="vagent.${digest}"
state_dir="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-${owner_id}"
mkdir -p "${state_dir}/logs"

web_port="${WEB_PORT:-4173}"
api_port="${PORT:-8787}"

pid_alive() { kill -0 "$1" 2>/dev/null; }

read_state() { # $1=file -> sets st_pid st_start st_cwd st_cmd st_pgid st_port
  st_pid="$(grep -m1 '^pid=' "$1" | cut -d= -f2-)"
  st_start="$(grep -m1 '^start_time=' "$1" | cut -d= -f2-)"
  st_cwd="$(grep -m1 '^cwd=' "$1" | cut -d= -f2-)"
  st_cmd="$(grep -m1 '^command=' "$1" | cut -d= -f2-)"
  st_pgid="$(grep -m1 '^pgid=' "$1" | cut -d= -f2-)"
  st_port="$(grep -m1 '^port=' "$1" | cut -d= -f2-)"
}

owner_of_port() { # best-effort occupant description for a listening port
  port="$1"
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ')"
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' ')"
  else
    pids=""
  fi
  for p in ${pids}; do
    cmd="$(ps -o args= -p "${p}" 2>/dev/null | head -c 200)"
    say "port ${port}: occupied by pid ${p} (${cmd:-unknown command})"
  done
}

port_listening() {
  port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR > 1 {print $4}' | grep -q ":${port}\$"
  else
    return 1
  fi
}

check_port_free() { # $1=port $2=service-name $3=state-file
  port="$1"; svc="$2"; state_file="$3"
  if [ -f "${state_file}" ]; then
    read_state "${state_file}"
    if pid_alive "${st_pid}"; then
      say "${svc}: already running (pid ${st_pid})"
      return 10  # caller: treat as already started
    fi
    say "${svc}: clearing stale state (pid ${st_pid} not running)"
    rm -f "${state_file}"
  fi
  if port_listening "${port}"; then
    err "${svc}: port ${port} occupied by an unowned process — refusing to start"
    owner_of_port "${port}"
    exit 1
  fi
  return 0
}

wait_healthy() { # $1=port $2=pid — poll until healthy or process dies (max ~20s)
  port="$1"; svc_pid="$2"
  for _ in $(seq 1 100); do
    if node -e 'fetch(`http://127.0.0.1:${process.argv[1]}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "${port}" 2>/dev/null; then
      return 0
    fi
    if node -e 'fetch(`http://127.0.0.1:${process.argv[1]}/`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "${port}" 2>/dev/null; then
      return 0
    fi
    pid_alive "${svc_pid}" || return 1
    sleep 0.2
  done
  return 1
}

record_state() { # $1=service $2=pid $3=port $4=log
  svc="$1"; pid="$2"; port="$3"; log="$4"
  sleep 0.3  # let npm settle its process title before capturing identity
  start_time="$(ps -o lstart= -p "${pid}" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
  cmd="$(ps -o args= -p "${pid}" 2>/dev/null | sed 's/^ *//;s/ *$//' | head -c 400)"
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
  {
    printf 'service=%s\n' "${svc}"
    printf 'repo_root=%s\n' "${repo_root}"
    printf 'pid=%s\n' "${pid}"
    printf 'start_time=%s\n' "${start_time}"
    printf 'cwd=%s\n' "${cwd}"
    printf 'command=%s\n' "${cmd}"
    printf 'pgid=%s\n' "${pgid}"
    printf 'port=%s\n' "${port}"
    printf 'log=%s\n' "${log}"
    printf 'owner_id=%s\n' "${owner_id}"
  } > "${state_dir}/${svc}.state"
}


launch_service() { # $1=service $2=port $3...=command
  svc="$1"; port="$2"; shift 2
  log="${state_dir}/logs/${svc}.log"
  : > "${log}"
  set -m  # background job gets its own process group → npm parent + node child both group members
  ( cd "${repo_root}" && "$@" ) >> "${log}" 2>&1 &
  pid=$!
  set +m
  say "${svc}: starting (pid ${pid}, port ${port})"
  sleep 1
  if ! pid_alive "${pid}"; then
    err "${svc}: exited immediately; last log lines:"
    tail -n 10 "${log}" >&2 || true
    exit 1
  fi
  record_state "${svc}" "${pid}" "${port}" "${log}"
  if ! wait_healthy "${port}" "${pid}"; then
    err "${svc}: failed health check within 20s; stopping what was just started"
    pgid="$(grep -m1 '^pgid=' "${state_dir}/${svc}.state" | cut -d= -f2-)"
    [ -n "${pgid}" ] && kill -TERM -- "-${pgid}" 2>/dev/null
    sleep 1
    [ -n "${pgid}" ] && kill -KILL -- "-${pgid}" 2>/dev/null
    rm -f "${state_dir}/${svc}.state"
    err "${svc}: log tail:"
    tail -n 15 "${log}" >&2 || true
    exit 1
  fi
  say "${svc}: healthy on port ${port}"
}

# M5: prefer the lightweight local API, not the cloud-era OAuth/AWS API.
# Check BOTH ports before starting either service. Legacy fixture/repo behavior
# below stays intact when start:local-api does not exist.
if node -e 'process.exit(require(process.argv[1]).scripts?.["start:local-api"] ? 0 : 1)' "${repo_root}/package.json" 2>/dev/null; then
  check_port_free "${web_port}" web "${state_dir}/web.state"; web_rc=$?
  check_port_free "${api_port}" api "${state_dir}/api.state"; api_rc=$?
  if [ "${api_rc}" -eq 0 ]; then
    launch_service api "${api_port}" env PORT="${api_port}" NODE_OPTIONS=--max-old-space-size=256 npm run start:local-api
  fi
  if [ "${web_rc}" -eq 0 ]; then
    launch_service web "${web_port}" env WEB_PORT="${web_port}" VERIFIAI_LOCAL_API_URL="http://127.0.0.1:${api_port}" NODE_OPTIONS=--max-old-space-size=256 npm run start:web
  fi
  say "state: ${state_dir}"
  say "result: started (local web + API; Docker only on demand)"
  exit 0
fi

# --- web (required for the local product) ----------------------------------
check_port_free "${web_port}" web "${state_dir}/web.state"
rc=$?
if [ "${rc}" -eq 10 ]; then
  :
elif [ "${rc}" -eq 0 ]; then
  launch_service web "${web_port}" npm run start:web
fi

# --- api (legacy apps/api): start ONLY when build + full env exist ----------
api_skip=""
if [ ! -f "${repo_root}/dist/apps/api/index.js" ]; then
  api_skip="build missing (run npm run build)"
fi
if [ -z "${api_skip}" ]; then
  for v in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_CALLBACK_URL \
           GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_CALLBACK_URL VERIFIAI_STATE_SECRET; do
    if [ -z "$(printenv "${v}" 2>/dev/null || true)" ]; then
      api_skip="missing env ${v} (presence-only check)"
      break
    fi
  done
fi
if [ -n "${api_skip}" ]; then
  say "api: SKIPPED (${api_skip})"
else
  check_port_free "${api_port}" api "${state_dir}/api.state"
  rc=$?
  if [ "${rc}" -eq 10 ]; then
    :
  elif [ "${rc}" -eq 0 ]; then
    launch_service api "${api_port}" npm run start:api
  fi
fi

say "state: ${state_dir}"
say "result: started"
exit 0

