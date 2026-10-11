#!/usr/bin/env bash
# Launches stock VS Code (dev build, headless, throwaway profile + workspace copy) and runs trace_scenarios.mjs against it.
# Prereqs: `npm ci`, `npm run transpile-client`, `npm run gulp compile-extensions`, `npm run electron`, codicon.ttf copied.
# Usage (repo root):  bash docs98/inventory/scripts/run_scenarios.sh <workdir> [port] [driver.mjs]   (driver defaults to trace_scenarios.mjs)
# Set PROC_TRACE=1 to also write per-process Node/Electron API counts to <workdir>/proc/<pid>.json (see node_hook.cjs).
# Output: <workdir>/<driver name>.json (e.g. trace_scenarios.json), <workdir>/shots/*.png, <workdir>/launch.log
set -euo pipefail
WORK=${1:?workdir required}; PORT=${2:-9333}; DRIVER=${3:-trace_scenarios.mjs}; ROOT=$(pwd)
rm -rf "$WORK/ud" "$WORK/ext" "$WORK/ws" "$WORK/shots"; mkdir -p "$WORK/ud" "$WORK/ext" "$WORK/ws/src/vs"
cp -r src/vs/editor "$WORK/ws/src/vs/editor"          # throwaway copy: scenarios never touch the real tree
cp docs98/00-overview.md "$WORK/ws/README.md"; cp package.json "$WORK/ws/package.json"
export NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1 ELECTRON_ENABLE_LOGGING=1
# PROC_TRACE=1: record Node/Electron API usage of every process. How the hook gets into each kind of process:
#   - Electron main process:   `-r node_hook.cjs` on the command line (NODE_OPTIONS=--require is rejected there)
#   - utility processes:       a one-line import prepended to the generated out/bootstrap-fork.js (restored on exit)
#   - ELECTRON_RUN_AS_NODE children (language servers etc.): NODE_OPTIONS=--require inherited through the environment
HOOK_ARGS=()
if [ -n "${PROC_TRACE:-}" ]; then
	rm -rf "$WORK/proc"; export VSCODE98_TRACE_DIR="$WORK/proc" NODE_OPTIONS="--require=$ROOT/docs98/inventory/scripts/node_hook.cjs"
	HOOK_ARGS=(-r "$ROOT/docs98/inventory/scripts/node_hook.cjs")
	cp out/bootstrap-fork.js "$WORK/bootstrap-fork.js.orig"
	{ echo "import \"file://$ROOT/docs98/inventory/scripts/node_hook_esm.mjs\";"; cat "$WORK/bootstrap-fork.js.orig"; } > out/bootstrap-fork.js
fi
setsid .build/electron/code-oss "${HOOK_ARGS[@]}" . "$WORK/ws" --ozone-platform=headless --disable-gpu --no-sandbox --remote-debugging-port="$PORT" \
	--user-data-dir="$WORK/ud" --extensions-dir="$WORK/ext" --disable-extension=vscode.vscode-api-tests \
	--disable-telemetry --skip-welcome --skip-release-notes --disable-workspace-trust > "$WORK/launch.log" 2>&1 &
APP=$!
# setsid made the app a process-group leader; kill only that group (never other code-oss instances)
trap 'kill -- -$APP 2>/dev/null || true; [ -f "$WORK/bootstrap-fork.js.orig" ] && cp "$WORK/bootstrap-fork.js.orig" out/bootstrap-fork.js' EXIT
env -u NODE_OPTIONS -u VSCODE98_TRACE_DIR node "docs98/inventory/scripts/$DRIVER" "$PORT" "$WORK/${DRIVER%.mjs}.json" "$WORK/shots"
