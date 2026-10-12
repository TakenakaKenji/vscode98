#!/usr/bin/env bash
# Builds a relocatable Windows test package: the host exe, the JavaScript it needs (same directory layout as the repo, so relative imports resolve) and generated Node shims with relative
# imports. Usage (repo root, Node on PATH, mingw-w64 installed): bash docs98/spikes/11-windows-host/host/package_win.sh <outDir> [x86|x64]
set -euo pipefail
OUT=$(mkdir -p "${1:?outDir}" && cd "$1" && pwd); ARCH=${2:-x86}; ROOT=$(pwd); S=docs98/spikes; J="$OUT/js"
rm -rf "$J" "$OUT/results"; mkdir -p "$J"
bash "$S/11-windows-host/host/build_win.sh" "$OUT/build" "$ARCH" >/dev/null; cp "$OUT/build/qjs-win-$ARCH.exe" "$OUT/"
for d in 02-node-shim/host 05-child-process/host 05-child-process/tests 06-rendering/host 07-native-render/host 08-workbench-boot/host 10-main-shim/host 11-windows-host/host 11-windows-host/tests; do mkdir -p "$J/$S/$d"; cp -r "$S/$d/." "$J/$S/$d/"; done
mkdir -p "$J/node_modules/opentype.js" && cp -r node_modules/opentype.js/dist node_modules/opentype.js/package.json "$J/node_modules/opentype.js/"
# shims + impl with relative references; the layout the scripts expect is <root>/s11/shims and <root>/s11.impl
mkdir -p "$OUT/empty-bundle" && : > "$OUT/empty-bundle/x.js"
SHIM_RELATIVE=1 node "$S/05-child-process/host/build_impl.mjs" "$J/s11.impl" "$J/s11/shims" >/dev/null
# gen_shims runs from the package copy, so the paths it writes (relative to the shims) point at the package copy of the implementations
( cd "$J" && SHIM_RELATIVE=1 SHIM_IMPL_DIRS="$J/s11.impl" node "$S/02-node-shim/host/gen_shims.mjs" "$OUT/empty-bundle" "$J/s11" x.js >/dev/null )
for f in "$S/11-windows-host/package/"*.cmd; do sed 's/\r$//; s/$/\r/' "$f" > "$OUT/$(basename "$f")"; done   # batch files want CRLF
rm -rf "$OUT/build" "$OUT/empty-bundle"
echo "package: $OUT ($(du -sh "$OUT" | cut -f1))"
