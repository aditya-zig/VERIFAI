#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
cd "$ROOT"
KIT="$ROOT/ops/local-agent/scripts"

for f in "$KIT"/*.sh; do bash -n "$f"; done
echo "PASS shell syntax"

has_script(){ node -e 'const p=require("./package.json"); process.exit(p.scripts?.[process.argv[1]] ? 0 : 1)' "$1"; }

has_script typecheck || { echo "FAIL npm script 'typecheck' missing"; exit 1; }
npm run typecheck

if has_script test:local-e2e; then
  npm run test:local-e2e
elif has_script check; then
  echo "INFO test:local-e2e is not present in this checkout; using existing repository check instead"
  npm run check
else
  echo "FAIL neither test:local-e2e nor check exists"
  exit 1
fi

echo "PASS automated local verification"
echo "MANUAL REQUIRED for UI changes: open the local URL and verify the real browser flow."
