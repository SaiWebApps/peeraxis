#!/usr/bin/env bash
# Peeraxis plug-in acceptance: runs one hidden test against a seeded, throwaway engine.
#   PEERAXIS_DEMO_SPEC    test file, relative to the repo root (required)
#   PEERAXIS_DEMO_OUTPUT  folder for report.json, video and screenshots (required)
# A *.spec.ts file that imports @playwright/test runs in a browser against `main.ts serve`;
# any other test file runs with node --test. No model is ever called.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${PEERAXIS_DEMO_SPEC:?}" "${PEERAXIS_DEMO_OUTPUT:?}"
mkdir -p "$PEERAXIS_DEMO_OUTPUT"
export PEERAXIS_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pxhome.XXXXXX")"
node engine/test/seed.ts >"$PEERAXIS_HOME/seed.json"
export PEERAXIS_SEED="$PEERAXIS_HOME/seed.json"

if ! grep -q "@playwright/test" "$PEERAXIS_DEMO_SPEC"; then
  node --test "$PEERAXIS_DEMO_SPEC"
  exit
fi

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
export PEERAXIS_PORT="$PORT"
set -m
node engine/src/main.ts serve >"$PEERAXIS_HOME/serve.log" 2>&1 &
SERVER=$!
set +m
trap 'kill -TERM -- "-$SERVER" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  kill -0 "$SERVER" 2>/dev/null || { cat "$PEERAXIS_HOME/serve.log" >&2; echo "acceptance.sh: server exited" >&2; exit 1; }
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" && break
  sleep 0.5
done
npx playwright test --config playwright.config.ts
