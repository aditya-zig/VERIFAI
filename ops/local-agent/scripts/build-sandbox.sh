#!/usr/bin/env bash
# One small, labelled M4 image. Never invoked automatically by an audit.
set -eu
root="$(git rev-parse --show-toplevel)"
cd "${root}"
./ops/local-agent/scripts/preflight.sh
./ops/local-agent/scripts/check-docker.sh
free_kb="$(df -Pk "${root}" | awk 'END {print $4}')"
if [ "${free_kb}" -lt 20971520 ]; then
  printf '%s\n' 'Incomplete: sandbox build requires at least 20 GiB free disk.' >&2
  exit 1
fi
owner="vagent.$(printf '%s' "${root}" | sha256sum | cut -c1-12)"
docker build --label "dev.verifiai.local-agent.owner=${owner}" \
  --label dev.verifiai.local-agent.kind=audit-image \
  -t verifai-local-audit:m4 -f infra/local/audit.Dockerfile infra/local
