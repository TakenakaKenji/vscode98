#!/usr/bin/env bash
# Stage 1: native rasterizer vs the JavaScript backend, both on QuickJS, byte-for-byte, on the Monaco scenarios and the workbench replay.
# Usage (repo root): QJS7=<qjs-spike7> bash docs98/spikes/07-native-render/tests/raster_compare.sh <monacoDir> <workbench.json> <outDir>
set -uo pipefail
M=${1:?monacoDir}; WB=${2:?workbench.json}; OUT=${3:?outDir}; Q=${QJS7:?QJS7}; H=docs98/spikes/06-rendering/host; T=docs98/spikes/06-rendering/tests; mkdir -p "$OUT"; cp $T/editor_common.js "$M/"
ulimit -s 1048576
cmpppm() { if cmp -s "$1" "$2"; then echo "  byte-identical"; else echo "  DIFFERENT: $(cmp -l "$1" "$2" | wc -l) bytes differ, max delta $(cmp -l "$1" "$2" | awk '{d=strtonum("0"$2)-strtonum("0"$3); if(d<0)d=-d; if(d>m)m=d} END{print m+0}')"; fi; }
for p in $(cd $T/pages && ls *.html | sed 's/\.html$//'); do
	echo "=== monaco/$p"; cp $T/pages/$p.html "$M/$p.html"
	for be in js native; do $Q --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --ppm "$OUT/$p.$be.ppm" --backend $be 2>&1 | grep "^painted" | sed "s/^/  [$be] /" | cut -c1-200; done
	cmpppm "$OUT/$p.js.ppm" "$OUT/$p.native.ppm"
done
echo "=== workbench replay"
for be in js native; do $Q --stack-size 0 $H/run_replay_qjs.mjs "$WB" --ppm "$OUT/wb.$be.ppm" --backend $be 2>&1 | grep "^painted" | sed "s/^/  [$be] /" | cut -c1-220; done
cmpppm "$OUT/wb.js.ppm" "$OUT/wb.native.ppm"
