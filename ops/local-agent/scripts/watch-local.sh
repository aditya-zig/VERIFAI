#!/usr/bin/env bash
# Small lifecycle watcher: reconciles kit-owned state only. Never signals workers.
set -u

usage(){ printf '%s\n' "usage: watch-local.sh [--interval SECONDS]" >&2; }
interval=2
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) shift; [ $# -gt 0 ] || { usage; exit 1; }; interval="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
  shift
done
[[ "$interval" =~ ^[1-9][0-9]*$ ]] || { usage; exit 1; }

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$repo_root" ] || { printf '%s\n' "watch-local: not inside a Git repository" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  digest="$(printf '%s' "$repo_root" | sha256sum | awk '{print substr($1,1,12)}')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(printf '%s' "$repo_root" | shasum -a 256 | awk '{print substr($1,1,12)}')"
else
  digest="$(printf '%s' "$repo_root" | cksum | awk '{printf "%012d",$1}')"
fi
owner_id="vagent.${digest}"
state_dir="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-${owner_id}"
mkdir -p "$state_dir"

command -v flock >/dev/null 2>&1 || { printf '%s\n' "watch-local: flock is required" >&2; exit 1; }
exec 9>"$state_dir/watcher.lock"
if ! flock -n 9; then
  printf '%s\n' "watcher: already running"
  exit 0
fi

printf '%s\n' "$$" > "$state_dir/watcher.pid"
trap 'rm -f "$state_dir/watcher.pid"; exit 0' TERM INT EXIT

script_dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "watcher: running"
while true; do
  "$script_dir/reconcile-local.sh" >/dev/null 2>&1 || true
  sleep "$interval" &
  wait $!
done
