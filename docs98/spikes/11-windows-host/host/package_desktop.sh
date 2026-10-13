#!/usr/bin/env bash
# Builds the desktop test package for Windows: everything of package_win.sh plus a lean app bundle (the out/ of host/build_desktop.sh of spike 10 without source maps, the node_modules the
# app actually loads with the native binaries emptied (the addons are JavaScript stand-ins), a few built-in extensions) and run-desktop.cmd.
# Usage (repo root): APP=<appRoot built by build_desktop.sh> bash docs98/spikes/11-windows-host/host/package_desktop.sh <outDir> [x86|x64]
set -euo pipefail
OUT=$(mkdir -p "${1:?outDir}" && cd "$1" && pwd); ARCH=${2:-x86}; APP=${APP:?appRoot}; ROOT=$(pwd); S=docs98/spikes; J="$OUT/js"
bash "$S/11-windows-host/host/package_win.sh" "$OUT" "$ARCH" >/dev/null
# shims with the stub exports the real bundles need
( cd "$J" && SHIM_RELATIVE=1 SHIM_IMPL_DIRS="$J/s11.impl" node "$S/02-node-shim/host/gen_shims.mjs" "$APP/out" "$J/s11" main.js mainImpl.js bootstrap-fork.js vs/workbench/api/node/extensionHostProcess.js vs/code/electron-utility/sharedProcess/sharedProcessMain.js vs/platform/files/node/watcher/watcherMain.js vs/platform/terminal/node/ptyHostMain.js vs/platform/agentHost/node/agentHostMain.js >/dev/null ) && rm -rf "$J/s11/bundle"
copytree() { src=$1; dst=$2; shift 2; mkdir -p "$dst"; ( cd "$src" && tar cf - "$@" . ) | ( cd "$dst" && tar xf - ); }   # copytree <src> <dst> [tar --exclude options]
A="$OUT/app"; rm -rf "$A"; mkdir -p "$A"
copytree "$APP/out" "$A/out" --exclude='*.map'
cp "$APP/product.json" "$APP/package.json" "$A/"
mkdir -p "$A/node_modules"
while read -r p; do [ -n "$p" ] || continue; copytree "$ROOT/node_modules/$p" "$A/node_modules/$p" --exclude='*.md' --exclude='*.map' --exclude='test' --exclude='tests' --exclude='docs' --exclude='.github' --exclude='*.d.ts'; done < "${NEEDMODS:-/tmp/claude-0/needmods.txt}"
find "$A/node_modules" -name '*.node' -exec truncate -s 0 {} \;              # the native addons are stand-ins (native_addons98.js); the files only have to exist for module resolution
rm -rf "$A/node_modules/@vscode/tree-sitter-wasm"                              # 21 MB of parsers the first run does not need
mkdir -p "$A/extensions"; cp -r extensions/theme-defaults "$A/extensions/"
mkdir -p "$A/extensions/git"; for f in package.json package.nls.json; do cp "extensions/git/$f" "$A/extensions/git/"; done; cp -r extensions/git/out extensions/git/resources "$A/extensions/git/" 2>/dev/null || true
# fonts: the renderer's font table names /usr/share/fonts/...; ship the files it uses next to the app (fonts/<same subpath>) and point --font-dir at them
mkdir -p "$OUT/fonts/opentype/inter" "$OUT/fonts/truetype/dejavu" "$OUT/fonts/truetype/liberation" "$OUT/fonts/LICENSES"
for f in /usr/share/fonts/opentype/inter/Inter-*.otf; do cp "$f" "$OUT/fonts/opentype/inter/"; done
cp /usr/share/fonts/truetype/dejavu/DejaVu*.ttf "$OUT/fonts/truetype/dejavu/"; cp /usr/share/fonts/truetype/liberation/Liberation*.ttf "$OUT/fonts/truetype/liberation/"
for d in fonts-inter fonts-dejavu-core fonts-liberation; do [ -f /usr/share/doc/$d/copyright ] && cp /usr/share/doc/$d/copyright "$OUT/fonts/LICENSES/$d.txt"; done
mkdir -p "$OUT/sample" && printf 'hello vscode98\nline two\n' > "$OUT/sample/hello.txt" && printf '# sample\n' > "$OUT/sample/README.md"
sed 's/\r$//; s/$/\r/' "$S/11-windows-host/package/run-desktop.cmd" > "$OUT/run-desktop.cmd"
echo "desktop package: $OUT ($(du -sh "$OUT" | cut -f1))"
