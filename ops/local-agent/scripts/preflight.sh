#!/usr/bin/env bash
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "FAIL git repo: not inside a Git repository"
  exit 1
fi
cd "$ROOT"

echo "VERIFAI local-agent preflight"
echo "repo:   $ROOT"
echo "branch: $(git branch --show-current 2>/dev/null || echo unknown)"
echo "state:  $([[ -n "$(git status --porcelain 2>/dev/null)" ]] && echo dirty || echo clean)"
echo "commit: $(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
echo "node:   $(node --version 2>/dev/null || echo missing)"
echo "npm:    $(npm --version 2>/dev/null || echo missing)"

if command -v free >/dev/null 2>&1; then
  echo "free RAM: $(free -h | awk '/^Mem:/ {print $7 " available / " $2 " total"}')"
elif [[ "$(uname -s)" == "Darwin" ]] && command -v vm_stat >/dev/null 2>&1; then
  pages_free="$(vm_stat | awk '/Pages free/ {gsub("\\.","",$3); print $3}')"
  page_size="$(vm_stat | awk 'NR==1 {gsub("[^0-9]","",$8); print $8}')"
  [[ -n "$page_size" ]] || page_size=4096
  echo "free RAM: ~$(( pages_free * page_size / 1024 / 1024 )) MiB free (vm_stat)"
else
  echo "free RAM: unknown"
fi

echo "disk:"
df -hP "$ROOT" | tail -n 1

if command -v docker >/dev/null 2>&1; then
  echo "docker: available"
  if docker info >/dev/null 2>&1; then echo "docker status: running"; else echo "docker status: unavailable/stopped"; fi
else
  echo "docker: not installed (OK before M4)"
fi

port_status() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port: IN USE"; else echo "port $port: free"; fi
  elif command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then echo "port $port: IN USE"; else echo "port $port: free"; fi
  else
    echo "port $port: unknown (no lsof/ss)"
  fi
}
for p in 4173 8787 8789 8790 8791 8792 8793; do port_status "$p"; done

env_present() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    echo "env $name: present (shell)"
  elif [[ -f "$ROOT/.env" ]] && grep -Eq "^[[:space:]]*${name}=[^[:space:]].*" "$ROOT/.env"; then
    echo "env $name: present (.env)"
  else
    echo "env $name: not set"
  fi
}

for name in VERIFIAI_MODEL_PROVIDER VERIFIAI_MODEL_ID OPENROUTER_API_KEY NVIDIA_API_KEY VERIFIAI_STATE_SECRET GITHUB_CLIENT_ID GOOGLE_CLIENT_ID; do
  env_present "$name"
done
