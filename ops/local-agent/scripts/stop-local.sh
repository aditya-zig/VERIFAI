#!/usr/bin/env bash
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT" ]] || { echo "FAIL not inside a Git repository"; exit 1; }
STATE_DIR="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
[[ -d "$STATE_DIR" ]] || { echo "PASS no kit-owned processes recorded"; exit 0; }
[[ "$(cat "$STATE_DIR/owner-root" 2>/dev/null || true)" == "$ROOT" ]] || { echo "FAIL state ownership marker mismatch; refusing to stop anything"; exit 1; }

pid_cwd(){
  local pid="$1"
  if [[ -e "/proc/$pid/cwd" ]]; then readlink "/proc/$pid/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk 'substr($0,1,1)=="n"{print substr($0,2); exit}'
  fi
}

rc=0
for name in api web; do
  file="$STATE_DIR/$name.pid"
  [[ -f "$file" ]] || continue
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then echo "WARN invalid $name PID file; leaving it untouched"; rc=1; continue; fi
  if ! kill -0 "$pid" 2>/dev/null; then rm -f "$file"; echo "PASS $name already stopped"; continue; fi
  cwd="$(pid_cwd "$pid")"
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$cwd" != "$ROOT" ]] || [[ "$cmd" != *"npm run start:$name"* && "$cmd" != *"node "* ]]; then
    echo "WARN refusing to kill PID $pid: ownership could not be proven (cwd='$cwd')"
    rc=1
    continue
  fi
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then echo "WARN PID $pid did not stop; refusing SIGKILL automatically"; rc=1; else rm -f "$file"; echo "PASS stopped $name PID $pid"; fi
done
exit "$rc"
