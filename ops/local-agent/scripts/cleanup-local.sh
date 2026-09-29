#!/usr/bin/env bash
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT" ]] || { echo "FAIL not inside a Git repository"; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
OWNER_ID="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"

"$SCRIPT_DIR/stop-local.sh" || true

if [[ -d "$STATE_DIR" ]]; then
  if [[ "$(cat "$STATE_DIR/owner-root" 2>/dev/null || true)" != "$ROOT" ]]; then echo "FAIL state marker mismatch; refusing cleanup"; exit 1; fi
  if [[ -f "$STATE_DIR/owned-paths.txt" ]]; then
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      case "$path" in "$STATE_DIR"/tmp/*) rm -rf -- "$path" ;; *) echo "WARN refusing unowned path: $path" ;; esac
    done < "$STATE_DIR/owned-paths.txt"
  fi
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ids="$(docker ps -aq --filter "label=dev.verifiai.local-agent.owner=$OWNER_ID")"
  if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null && echo "PASS removed kit-owned Docker containers"; fi
fi

if [[ -d "$STATE_DIR" ]]; then
  active=0
  for f in "$STATE_DIR"/*.pid; do [[ -e "$f" ]] || continue; pid="$(cat "$f" 2>/dev/null || true)"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && active=1; done
  if [[ $active -eq 0 ]]; then rm -rf -- "$STATE_DIR"; echo "PASS removed kit-owned state/logs"; else echo "WARN live owned process remains; state preserved"; fi
fi
