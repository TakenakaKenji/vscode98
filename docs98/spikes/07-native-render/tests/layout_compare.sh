#!/usr/bin/env bash
# Stage 2: native layout (+ optionally the native rasterizer) vs the JavaScript layout, both on QuickJS: element geometry dumps and framebuffers must be identical.
# Usage (repo root): QJS7=<qjs-spike7> bash docs98/spikes/07-native-render/tests/layout_compare.sh <monacoDir> <workbench.json> <outDir>
set -uo pipefail
M=${1:?monacoDir}; WB=${2:?workbench.json}; OUT=${3:?outDir}; Q=${QJS7:?QJS7}; H=docs98/spikes/06-rendering/host; T=docs98/spikes/06-rendering/tests; mkdir -p "$OUT"; cp $T/editor_common.js "$M/"
ulimit -s 1048576
cmpdump() { python3 - "$1" "$2" <<'PY'
import json,sys
a=json.load(open(sys.argv[1]))['elements']; b=json.load(open(sys.argv[2]))['elements']; keys=['x','y','w','h','offsetW','offsetH','scrollW','scrollH']; bad=0; first=[]
if len(a)!=len(b): print(f"  DIFFERENT element count {len(a)} vs {len(b)}"); sys.exit()
for x,y in zip(a,b):
    d=[k for k in keys if (x.get(k) is None)!=(y.get(k) is None) or (x.get(k) is not None and abs(x[k]-y[k])>1e-9)]
    if d:
        bad+=1
        if len(first)<5: first.append((x['path'][-50:], x.get('cls','')[:25], [(k,x.get(k),y.get(k)) for k in d][:3]))
print(f"  geometry: {len(a)} elements, {bad} differ" + ("" if not bad else " e.g. "+str(first)))
PY
}
cmpppm() { if cmp -s "$1" "$2"; then echo "  framebuffer byte-identical"; else echo "  framebuffer DIFFERENT: $(cmp -l "$1" "$2" | wc -l) bytes"; fi; }
for p in $(cd $T/pages && ls *.html | sed 's/\.html$//'); do
	echo "=== monaco/$p"; cp $T/pages/$p.html "$M/$p.html"
	$Q --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --dump "$OUT/$p.js.json" --ppm "$OUT/$p.js.ppm" 2>&1 | grep -E "^loaded|^painted" | sed 's/^/  [js layout + js paint] /' | cut -c1-200
	$Q --stack-size 0 $H/run_qjs.mjs "$M" "$M/$p.html" --dump "$OUT/$p.nat.json" --ppm "$OUT/$p.nat.ppm" --layout native --backend native 2>&1 | grep -E "^loaded|^painted" | sed 's/^/  [native layout + native paint] /' | cut -c1-230
	cmpdump "$OUT/$p.js.json" "$OUT/$p.nat.json"; cmpppm "$OUT/$p.js.ppm" "$OUT/$p.nat.ppm"
done
echo "=== workbench replay"
$Q --stack-size 0 $H/run_replay_qjs.mjs "$WB" --dump "$OUT/wb.js.json" --ppm "$OUT/wb.js.ppm" 2>&1 | grep -E "^style|^painted" | sed 's/^/  [js layout + js paint] /' | cut -c1-200
$Q --stack-size 0 $H/run_replay_qjs.mjs "$WB" --dump "$OUT/wb.nat.json" --ppm "$OUT/wb.nat.ppm" --layout native --backend native 2>&1 | grep -E "^style|^painted" | sed 's/^/  [native layout + native paint] /' | cut -c1-230
cmpdump "$OUT/wb.js.json" "$OUT/wb.nat.json"; cmpppm "$OUT/wb.js.ppm" "$OUT/wb.nat.ppm"
