#!/usr/bin/env bash
# Boots the desktop workbench (real electron-main bundle, utility processes, extension host, renderer on the spike 6/7 engine) entirely on QuickJS and runs a scenario.
# Usage (repo root): QJS7=<qjs-spike7> bash docs98/spikes/10-main-shim/tests/run_desktop.sh <appRoot> <shimsDir> <userDataDir> [scenario name: edit|status|procs|console] [workspace dir] [out.ppm]
set -euo pipefail
APP=${1:?appRoot}; SH=${2:?shimsDir}; UD=${3:?userDataDir}; SC=${4:-}; WS=${5:-}; PPM=${6:-}; H=$(pwd)/docs98/spikes/10-main-shim/host; ulimit -s 1048576
ARGS=(--layout native --backend native --user-data-dir "$UD" --seconds 120 --stable 400); [ -n "$SC" ] && ARGS+=(--scenario "$H/scenario_$SC.mjs"); [ -n "$WS" ] && ARGS+=(--workspace "$WS"); [ -n "$PPM" ] && ARGS+=(--ppm "$PPM")
"${QJS7:?QJS7}" --stack-size 0 docs98/spikes/05-child-process/host/fork_main.mjs "$SH" "$H/boot_desktop_qjs.mjs" "$APP" "${ARGS[@]}"
