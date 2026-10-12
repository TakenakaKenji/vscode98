#!/usr/bin/env bash
# Boots the web workbench on the QuickJS host (native layout + integer rasterizer) and optionally runs the scripted interaction scenario.
# Usage (repo root): QJS7=<qjs-spike7> bash docs98/spikes/08-workbench-boot/tests/run_boot.sh <outWebDir> <out.ppm> [scenario]   (takes 3 to 8 minutes: every layout pass restyles the whole tree)
set -euo pipefail
W=${1:?outWebDir}; P=${2:?out.ppm}; S=${3:-}; H=docs98/spikes/08-workbench-boot/host; ulimit -s 1048576
ARGS=(--seconds 120 --layout native --backend native --ppm "$P"); [ -n "$S" ] && ARGS+=(--scenario "$(pwd)/$H/scenario_$S.mjs")
"${QJS7:?QJS7}" --stack-size 0 $H/boot_qjs.mjs "$W" "${ARGS[@]}"
