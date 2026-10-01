#!/usr/bin/env bash
# Reconcile kit-owned process metadata without signalling any process.
set -u

say(){ printf '%s\n' "$*"; }
err(){ printf '%s\n' "$*" >&2; }

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$repo_root" ] || { err "reconcile-local: not inside a Git repository"; exit 1; }

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

norm(){ printf '%s' "$1" | sed 's/  */ /g; s/^ //; s/ $//'; }
field(){ grep -m1 "^$1=" "$2" 2>/dev/null | cut -d= -f2-; }

unknown=0
shopt -s nullglob
files=("$state_dir"/*.state)
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  say "result: no active state"
  exit 0
fi

for f in "${files[@]}"; do
  svc="$(field service "$f")"
  pid="$(field pid "$f")"
  want_start="$(field start_time "$f")"
  want_cwd="$(field cwd "$f")"
  want_cmd="$(field command "$f")"

  if [ -z "$svc" ] || ! [[ "$pid" =~ ^[0-9]+$ ]] || [ -z "$want_start" ] || [ -z "$want_cmd" ]; then
    err "$(basename "$f"): Unknown (corrupt/incomplete state); preserved"
    unknown=1
    continue
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    {
      printf 'service=%s\n' "$svc"
      printf 'pid=%s\n' "$pid"
      printf 'status=Crashed\n'
      printf 'reason=owned process disappeared\n'
    } > "$state_dir/$svc.exit"
    rm -f "$f"
    say "$svc: Crashed (recorded process gone); reconciled"
    continue
  fi

  got_start="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  got_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  got_cmd="$(ps -o args= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//' | head -c 400)"

  if [ "$(norm "$got_start")" = "$(norm "$want_start")" ] &&
     { [ -z "$want_cwd" ] || [ "$got_cwd" = "$want_cwd" ]; } &&
     [ "$(norm "$got_cmd")" = "$(norm "$want_cmd")" ]; then
    say "$svc: Running (identity verified)"
  else
    err "$svc: StaleOwnership (pid $pid reused or identity changed); preserved, no signal sent"
    unknown=1
  fi
done

[ "$unknown" -eq 0 ] || exit 2
say "result: reconciled"
