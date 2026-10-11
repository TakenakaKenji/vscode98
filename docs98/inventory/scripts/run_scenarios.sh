#!/usr/bin/env bash
# Launches stock VS Code (dev build, headless, throwaway profile + workspace copy) and runs trace_scenarios.mjs against it.
# Prereqs: `npm ci`, `npm run transpile-client`, `npm run gulp compile-extensions`, `npm run electron`, codicon.ttf copied.
# Usage (repo root):  bash docs98/inventory/scripts/run_scenarios.sh <workdir> [port] [driver.mjs]   (driver defaults to trace_scenarios.mjs)
# Output: <workdir>/<driver name>.json (e.g. trace_scenarios.json), <workdir>/shots/*.png, <workdir>/launch.log
set -euo pipefail
WORK=${1:?workdir required}; PORT=${2:-9333}; DRIVER=${3:-trace_scenarios.mjs}; ROOT=$(pwd)
rm -rf "$WORK/ud" "$WORK/ext" "$WORK/ws" "$WORK/shots"; mkdir -p "$WORK/ud" "$WORK/ext" "$WORK/ws/src/vs"
cp -r src/vs/editor "$WORK/ws/src/vs/editor"          # throwaway copy: scenarios never touch the real tree
cp docs98/00-overview.md "$WORK/ws/README.md"; cp package.json "$WORK/ws/package.json"
export NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1 ELECTRON_ENABLE_LOGGING=1
setsid .build/electron/code-oss . "$WORK/ws" --ozone-platform=headless --disable-gpu --no-sandbox --remote-debugging-port="$PORT" \
	--user-data-dir="$WORK/ud" --extensions-dir="$WORK/ext" --disable-extension=vscode.vscode-api-tests \
	--disable-telemetry --skip-welcome --skip-release-notes --disable-workspace-trust > "$WORK/launch.log" 2>&1 &
APP=$!
# setsid made the app a process-group leader; kill only that group (never other code-oss instances)
trap 'kill -- -$APP 2>/dev/null || true' EXIT
node "docs98/inventory/scripts/$DRIVER" "$PORT" "$WORK/${DRIVER%.mjs}.json" "$WORK/shots"
