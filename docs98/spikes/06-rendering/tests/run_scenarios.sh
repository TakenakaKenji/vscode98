#!/usr/bin/env bash
# For each page in tests/pages: ground truth from headless Chromium, our DOM/layout/painter under Node, then element-level and pixel comparison.
# Usage (repo root, Node 24 on PATH): bash docs98/spikes/06-rendering/tests/run_scenarios.sh <monacoDir> <outDir> [page...]
set -uo pipefail
M=${1:?monacoDir}; OUT=${2:?outDir}; shift 2; T=docs98/spikes/06-rendering/tests; H=docs98/spikes/06-rendering/host
PAGES=("$@"); [ ${#PAGES[@]} -gt 0 ] || PAGES=($(cd $T/pages && ls *.html | sed 's/\.html$//'))
mkdir -p "$OUT"; cp $T/editor_common.js "$M/"
for p in "${PAGES[@]}"; do
	echo "=== $p"
	node $T/chromium_truth.mjs "$M" "$OUT/$p.truth" $T/pages/$p.html | sed 's/^/  chromium: /'
	cp $T/pages/$p.html "$M/$p.html"
	node $H/run_node.mjs "$M" --page "$M/$p.html" --dump "$OUT/$p.ours.json" --ppm "$OUT/$p.ours.ppm" 2>&1 | grep -v "^    at \|^Trace\|^Could not\|^Worker" | sed 's/^/  ours: /'
	python3 $T/compare.py "$OUT/$p.truth.json" "$OUT/$p.ours.json" --verbose 8 2>&1 | grep -v "^     " | sed 's/^/  /'
	python3 -W ignore $T/pixel_diff.py "$OUT/$p.truth.png" "$OUT/$p.ours.ppm" "$OUT/$p" | sed 's/^/  pixels: /'
	if [ -n "${QJS:-}" ]; then
		( ulimit -s 1048576; $QJS --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --dump "$OUT/$p.qjs.json" --ppm "$OUT/$p.qjs.ppm" 2>&1 | sed 's/^/  quickjs: /' )
		python3 $T/compare.py "$OUT/$p.truth.json" "$OUT/$p.qjs.json" --verbose 0 2>&1 | grep -E "^elements|within 0.5|offsetW|scroll|text content|inline style" | sed 's/^/  quickjs vs chromium: /'
		cmp -s "$OUT/$p.ours.ppm" "$OUT/$p.qjs.ppm" && echo "  quickjs framebuffer identical to node's" || echo "  quickjs framebuffer differs from node's"
	fi
done
