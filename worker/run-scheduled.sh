#!/bin/bash
# Wrapper script invoked by launchd at the scheduled analysis time.
#
# Pulls latest main from origin so code changes pushed from any PC are
# picked up before the next run, then runs the worker. ai-debate server
# is expected to already be running on http://localhost:3000.
#
# Logs go to /tmp/totolab-worker.log (also captured by launchd plist).

set -euo pipefail

REPO_DIR="${TOTOLAB_REPO_DIR:-/Users/dw/Projects/toto-lab}"
NODE_BIN="${TOTOLAB_NODE_BIN:-/opt/homebrew/bin/node}"
NPM_BIN="${TOTOLAB_NPM_BIN:-/opt/homebrew/bin/npm}"
HORIZON_HOURS="${TOTOLAB_HORIZON:-48}"

cd "$REPO_DIR"

echo "[run-scheduled] $(date '+%Y-%m-%d %H:%M:%S') starting"
echo "[run-scheduled] git pull origin main"
git fetch origin main --quiet
git checkout main --quiet
git reset --hard origin/main --quiet

cd worker

if [ ! -d node_modules ]; then
  echo "[run-scheduled] installing worker deps"
  "$NPM_BIN" install --silent
fi

echo "[run-scheduled] running worker (horizon=${HORIZON_HOURS}h)"
"$NODE_BIN" runOnce.js full "$HORIZON_HOURS"

echo "[run-scheduled] $(date '+%Y-%m-%d %H:%M:%S') done"
