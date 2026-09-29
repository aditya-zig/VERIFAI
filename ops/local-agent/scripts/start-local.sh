#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$ROOT"
STATE_DIR="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
mkdir -p "$STATE_DIR"
printf '%s\n' "$ROOT" > "$STATE_DIR/owner-root"

has_script(){ node -e 'const p=require("./package.json"); process.exit(p.scripts?.[process.argv[1]] ? 0 : 1)' "$1"; }
for s in build start:api start:web; do has_script "$s" || { echo "FAIL npm script '$s' does not exist"; exit 1; }; done

for f in "$STATE_DIR"/*.pid; do
  [[ -e "$f" ]] || continue
  pid="$(cat "$f" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "FAIL kit-owned process appears active (PID $pid). Run stop-local.sh first."; exit 1; fi
done

npm run build

nohup npm run start:api >"$STATE_DIR/api.log" 2>&1 &
echo $! > "$STATE_DIR/api.pid"
nohup npm run start:web >"$STATE_DIR/web.log" 2>&1 &
echo $! > "$STATE_DIR/web.pid"

sleep 2
for name in api web; do
  pid="$(cat "$STATE_DIR/$name.pid")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "FAIL $name exited during startup. See $STATE_DIR/$name.log"
    "$(dirname "$0")/stop-local.sh" || true
    exit 1
  fi
done

echo "PASS local processes started"
echo "Web: http://127.0.0.1:4173"
echo "API: http://127.0.0.1:8787"
echo "Logs: $STATE_DIR"
