#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [ "$#" -eq 0 ]; then
  npm run build
fi
exec ./ops/local-agent/scripts/start-local.sh "$@"
