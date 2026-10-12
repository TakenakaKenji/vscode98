#!/usr/bin/env bash
# Launches stock VS Code headless in either dev mode (unbundled out/) or bundled mode (out-vscode-min/, built with
# `node --experimental-strip-types build/next/index.ts bundle --out out-vscode-min --target desktop --minify --mangle-privates --nls`)
# and records startup time + memory with measure_baseline.mjs. No tracing hooks are loaded.
# Usage (repo root): bash docs98/inventory/scripts/run_baseline.sh <workdir> <dev|bundle> [port] [settleSeconds] [runs]
# Output: <workdir>/<mode>-<n>.json
set -euo pipefail
WORK=${1:?workdir}; MODE=${2:?dev|bundle}; PORT=${3:-9333}; SETTLE=${4:-20}; RUNS=${5:-3}; ROOT=$(pwd)
mkdir -p "$WORK"
APPDIR="$ROOT"
if [ "$MODE" = bundle ]; then
	[ -d out-vscode-min ] || { echo "out-vscode-min missing: build the bundle first" >&2; exit 1; }
	# Stage an app dir shaped like a packaged app (asar + unpacked natives), see stage_bundled_app.ts.
	APPDIR="$WORK/app"
	node --experimental-strip-types docs98/inventory/scripts/stage_bundled_app.ts "$APPDIR" 2>&1 | grep -v ExperimentalWarning
fi
for n in $(seq 1 "$RUNS"); do
	rm -rf "$WORK/ud" "$WORK/ext" "$WORK/ws"; mkdir -p "$WORK/ud" "$WORK/ext" "$WORK/ws"
	cp package.json "$WORK/ws/package.json"; cp docs98/00-overview.md "$WORK/ws/README.md"
	export ELECTRON_ENABLE_LOGGING=1
	if [ "$MODE" = dev ]; then export NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1; else unset NODE_ENV VSCODE_DEV; export VSCODE_CLI=1; fi
	START=$(date +%s%3N)
	setsid .build/electron/code-oss "$APPDIR" "$WORK/ws" --ozone-platform=headless --disable-gpu --no-sandbox --remote-debugging-port="$PORT" \
		--user-data-dir="$WORK/ud" --extensions-dir="$WORK/ext" --disable-extension=vscode.vscode-api-tests \
		--disable-telemetry --skip-welcome --skip-release-notes --disable-workspace-trust > "$WORK/launch-$MODE-$n.log" 2>&1 &
	APP=$!
	set +e
	node docs98/inventory/scripts/measure_baseline.mjs "$PORT" "$WORK/$MODE-$n.json" "$START" "$SETTLE"
	RC=$?
	set -e
	kill -- -$APP 2>/dev/null || true; sleep 3; pkill -f "remote-debugging-port=$PORT" 2>/dev/null || true; sleep 1
	[ $RC -eq 0 ] || echo "run $n ($MODE) failed rc=$RC, see $WORK/launch-$MODE-$n.log" >&2
done
