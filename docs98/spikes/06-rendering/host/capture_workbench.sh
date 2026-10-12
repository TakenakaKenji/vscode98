#!/usr/bin/env bash
# Launches the staged production bundle of VS Code headless (as docs98/inventory/scripts/run_baseline.sh does) and captures its DOM/CSS/boxes.
# Usage (repo root, Node 24 on PATH, out-vscode-min built): bash docs98/spikes/06-rendering/host/capture_workbench.sh <workdir> <out.json> [port]
set -euo pipefail
WORK=${1:?workdir}; OUT=${2:?out.json}; PORT=${3:-9334}; ROOT=$(pwd)
mkdir -p "$WORK"; APPDIR="$WORK/app"
node --experimental-strip-types docs98/inventory/scripts/stage_bundled_app.ts "$APPDIR" 2>&1 | grep -v ExperimentalWarning || true
rm -rf "$WORK/ud" "$WORK/ext" "$WORK/ws"; mkdir -p "$WORK/ud" "$WORK/ext" "$WORK/ws"; cp package.json "$WORK/ws/package.json"; cp docs98/00-overview.md "$WORK/ws/README.md"
unset NODE_ENV VSCODE_DEV; export VSCODE_CLI=1 ELECTRON_ENABLE_LOGGING=1
setsid .build/electron/code-oss "$APPDIR" "$WORK/ws" --ozone-platform=headless --disable-gpu --no-sandbox --remote-debugging-port="$PORT" --user-data-dir="$WORK/ud" --extensions-dir="$WORK/ext" --disable-extension=vscode.vscode-api-tests --disable-telemetry --skip-welcome --skip-release-notes --disable-workspace-trust > "$WORK/launch.log" 2>&1 &
APP=$!
set +e; node docs98/spikes/06-rendering/host/capture_workbench.mjs "$PORT" "$OUT" 4; RC=$?; set -e
kill -- -$APP 2>/dev/null || true; sleep 2; pkill -f "remote-debugging-port=$PORT" 2>/dev/null || true
exit $RC
