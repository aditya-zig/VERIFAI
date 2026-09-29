#!/usr/bin/env bash
set -u

if ! command -v docker >/dev/null 2>&1; then echo "WARN Docker not installed (OK before M4)"; exit 0; fi
if ! docker info >/dev/null 2>&1; then echo "WARN Docker installed but daemon unavailable"; exit 0; fi

echo "PASS Docker daemon reachable"
echo "Potential VERIFAI containers (inspection only):"
docker ps -a --filter 'name=verifiai' --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}' || true
ids="$(docker ps -aq --filter 'name=verifiai')"
if [[ -n "$ids" ]]; then
  echo "Resource snapshot:"
  docker stats --no-stream $ids 2>/dev/null || true
fi

echo "Cleanup safety: cleanup-local.sh removes only containers labelled dev.verifiai.local-agent.owner=<this checkout id>."
