#!/usr/bin/env bash
# Native engine vs the JavaScript reference, on QuickJS, for the 4 Monaco scenarios and the workbench replay:
#   native layout + exact rasterizer   must give identical geometry and a byte-identical framebuffer
#   native layout + integer rasterizer must give identical geometry and a framebuffer within tolerance (max 3 levels, mean abs < 0.1)
# Usage (repo root): QJS7=<qjs-spike7> bash docs98/spikes/07-native-render/tests/native_compare.sh <monacoDir> <workbench.json> <outDir>
set -uo pipefail
M=${1:?monacoDir}; WB=${2:?workbench.json}; OUT=${3:?outDir}; Q=${QJS7:?QJS7}; H=docs98/spikes/06-rendering/host; T=docs98/spikes/06-rendering/tests; T7=docs98/spikes/07-native-render/tests; mkdir -p "$OUT"; cp $T/editor_common.js "$M/"
ulimit -s 1048576; FAIL=0
cmpdump() { python3 - "$1" "$2" <<'PY'
import json,sys
a=json.load(open(sys.argv[1]))['elements']; b=json.load(open(sys.argv[2]))['elements']; keys=['x','y','w','h','offsetW','offsetH','scrollW','scrollH']; bad=0
if len(a)!=len(b): print(f"  geometry: DIFFERENT element count {len(a)} vs {len(b)}"); sys.exit(1)
for x,y in zip(a,b):
    if [k for k in keys if (x.get(k) is None)!=(y.get(k) is None) or (x.get(k) is not None and abs(x[k]-y[k])>1e-9)]: bad+=1
print(f"  geometry: {len(a)} elements, {bad} differ"); sys.exit(1 if bad else 0)
PY
}
check() { cmpdump "$OUT/$1.js.json" "$OUT/$1.exact.json" || FAIL=1
	if cmp -s "$OUT/$1.js.ppm" "$OUT/$1.exact.ppm"; then echo "  exact rasterizer: byte-identical"; else echo "  exact rasterizer: DIFFERENT"; FAIL=1; fi
	echo -n "  integer rasterizer: "; python3 -W ignore $T7/pixel_tolerance.py "$OUT/$1.js.ppm" "$OUT/$1.int.ppm" --max-diff 3 --max-mean 0.1 || FAIL=1; }
for p in $(cd $T/pages && ls *.html | sed 's/\.html$//'); do
	echo "=== monaco/$p"; cp $T/pages/$p.html "$M/$p.html"
	$Q --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --dump "$OUT/$p.js.json" --ppm "$OUT/$p.js.ppm" >/dev/null 2>&1
	$Q --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --dump "$OUT/$p.exact.json" --ppm "$OUT/$p.exact.ppm" --layout native --backend native-exact >/dev/null 2>&1
	$Q --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --dump "$OUT/$p.int.json" --ppm "$OUT/$p.int.ppm" --layout native --backend native 2>&1 | grep -E "^painted" | sed 's/^/  [integer] /' | cut -c1-120
	check "$p"
done
echo "=== workbench replay"
$Q --stack-size 0 $H/run_replay_qjs.mjs "$WB" --dump "$OUT/wb.js.json" --ppm "$OUT/wb.js.ppm" >/dev/null 2>&1
$Q --stack-size 0 $H/run_replay_qjs.mjs "$WB" --dump "$OUT/wb.exact.json" --ppm "$OUT/wb.exact.ppm" --layout native --backend native-exact >/dev/null 2>&1
$Q --stack-size 0 $H/run_replay_qjs.mjs "$WB" --dump "$OUT/wb.int.json" --ppm "$OUT/wb.int.ppm" --layout native --backend native 2>&1 | grep -E "^painted" | sed 's/^/  [integer] /' | cut -c1-120
check wb
[ $FAIL = 0 ] && echo "ALL OK" || echo "FAILURES"; exit $FAIL
