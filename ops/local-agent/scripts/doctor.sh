#!/usr/bin/env bash
set -u

PASS=0; WARN=0; FAIL=0
pass(){ echo "PASS $*"; PASS=$((PASS+1)); }
warn(){ echo "WARN $*"; WARN=$((WARN+1)); }
fail(){ echo "FAIL $*"; FAIL=$((FAIL+1)); }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then fail "not inside a Git repository"; echo "Summary: $PASS PASS / $WARN WARN / $FAIL FAIL"; exit 1; fi
cd "$ROOT"

remote="$(git remote get-url origin 2>/dev/null || true)"
if [[ "$remote" =~ github\.com[:/]aditya-zig/VERIFAI(\.git)?$ ]]; then pass "canonical repository"; else fail "wrong/missing origin: expected aditya-zig/VERIFAI"; fi

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( major >= 22 )); then pass "Node $(node -v)"; else fail "Node 22+ required; found $(node -v 2>/dev/null || echo unknown)"; fi
else fail "Node missing"; fi

if command -v npm >/dev/null 2>&1; then pass "npm $(npm -v)"; else fail "npm missing"; fi
[[ -d node_modules ]] && pass "npm dependencies installed" || fail "node_modules missing; run npm install --no-audit --no-fund"

stage="${VERIFIAI_LOCAL_STAGE:-M1}"
if [[ "$stage" =~ ^M([2-9]|[1-9][0-9]+)$ ]]; then
  provider="${VERIFIAI_MODEL_PROVIDER:-}"
  [[ -n "$provider" ]] && pass "VERIFIAI_MODEL_PROVIDER present" || fail "VERIFIAI_MODEL_PROVIDER missing for $stage"
  [[ -n "${VERIFIAI_MODEL_ID:-}" ]] && pass "VERIFIAI_MODEL_ID present" || fail "VERIFIAI_MODEL_ID missing for $stage"
  case "$provider" in
    openrouter) [[ -n "${OPENROUTER_API_KEY:-}" ]] && pass "OpenRouter key present" || fail "OPENROUTER_API_KEY missing" ;;
    nvidia) [[ -n "${NVIDIA_API_KEY:-}" ]] && pass "NVIDIA key present" || fail "NVIDIA_API_KEY missing" ;;
    *ollama*) fail "Ollama is prohibited by the current local-first rules" ;;
    "") : ;;
    *) warn "provider '$provider' is not documented in the current local-agent kit; verify against current code/issue" ;;
  esac
else
  pass "$stage requires no model secret by this kit"
fi

port_used(){
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}$"
  else return 2; fi
}
for p in 4173 8787; do
  if port_used "$p"; then warn "port $p already occupied; verify owner before starting"; else rc=$?; [[ $rc -eq 2 ]] && warn "cannot inspect port $p" || pass "port $p free"; fi
done

if [[ "$stage" =~ ^M([4-9]|[1-9][0-9]+)$ ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then pass "Docker available for $stage"; else fail "Docker required for $stage but unavailable"; fi
else
  pass "Docker not required before M4"
fi

avail_mib=""
if command -v free >/dev/null 2>&1; then avail_mib="$(free -m | awk '/^Mem:/ {print $7}')"; fi
if [[ -n "$avail_mib" ]]; then
  if (( avail_mib >= 2048 )); then pass "RAM available: ${avail_mib} MiB"; else warn "low available RAM: ${avail_mib} MiB"; fi
else warn "RAM availability not measured"; fi

avail_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
if [[ "$stage" =~ ^M([4-9]|[1-9][0-9]+)$ ]]; then
  if [[ -n "$avail_kb" ]] && (( avail_kb >= 20971520 )); then pass "disk has at least 20 GiB free for Docker-stage work"; else fail "M4+ requires at least 20 GiB free before a heavy Docker build"; fi
else
  if [[ -n "$avail_kb" ]] && (( avail_kb >= 5242880 )); then pass "disk has at least 5 GiB free"; else warn "less than 5 GiB free or disk check unavailable"; fi
fi

state_dir="${TMPDIR:-/tmp}/verifiai-local-agent-$(id -u)-$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
if [[ -d "$state_dir" ]]; then
  stale=0
  for f in "$state_dir"/*.pid; do
    [[ -e "$f" ]] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then warn "stale kit PID file: $f"; stale=1; fi
  done
  [[ $stale -eq 1 ]] || pass "kit state has no stale PID files"
else pass "no stale kit state"; fi

echo "Summary: $PASS PASS / $WARN WARN / $FAIL FAIL"
(( FAIL == 0 ))
