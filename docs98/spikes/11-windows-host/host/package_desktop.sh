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
while read -r p; do [ -n "$p" ] || continue; copytree "$ROOT/node_modules/$p" "$A/node_modules/$p" --exclude='*.md' --exclude='*.map' --exclude='test' --exclude='tests' --exclude='docs' --exclude='.github' --exclude='*.d.ts'; done < "${NEEDMODS:-$S/11-windows-host/host/needmods.txt}"
RGDIR=$(bash "$S/11-windows-host/host/fetch_rg.sh"); mkdir -p "$A/node_modules/@vscode/ripgrep/bin" "$A/node_modules/@vscode/ripgrep/lib"   # the Search view runs rg.exe (the linux binary of the node module is useless here)
cp "$ROOT/node_modules/@vscode/ripgrep/package.json" "$A/node_modules/@vscode/ripgrep/"; cp "$ROOT/node_modules/@vscode/ripgrep/lib/index.js" "$A/node_modules/@vscode/ripgrep/lib/"; cp "$RGDIR/rg.exe" "$A/node_modules/@vscode/ripgrep/bin/rg.exe"; cp "$RGDIR/LICENSE-MIT" "$RGDIR/UNLICENSE" "$A/node_modules/@vscode/ripgrep/bin/"
# the bundles import @vscode/ripgrep-universal, which picks bin/<platform>-<arch>/rg.exe by process.arch: ia32 for the x86 host (the same 32-bit rg.exe also serves an x64 host)
RU="$A/node_modules/@vscode/ripgrep-universal"; mkdir -p "$RU/lib" "$RU/bin/win32-ia32" "$RU/bin/win32-x64"; cp "$ROOT/node_modules/@vscode/ripgrep-universal/package.json" "$RU/"; cp "$ROOT/node_modules/@vscode/ripgrep-universal/lib/index.js" "$RU/lib/"; cp "$RGDIR/rg.exe" "$RU/bin/win32-ia32/rg.exe"; cp "$RGDIR/rg.exe" "$RU/bin/win32-x64/rg.exe"; cp "$RGDIR/LICENSE-MIT" "$RGDIR/UNLICENSE" "$RU/"
find "$A/node_modules" -name '*.node' -exec truncate -s 0 {} \;              # the native addons are stand-ins (native_addons98.js); the files only have to exist for module resolution
rm -rf "$A/node_modules/@vscode/tree-sitter-wasm"                              # 21 MB of parsers the first run does not need
node "$S/11-windows-host/host/package_extensions.mjs" "$ROOT" "$A/extensions" | tail -1   # the built-in extensions: manifests, grammars, themes, compiled code and the production dependencies (not the 100 to 300 MB dev trees)
# fonts: the renderer's font table names /usr/share/fonts/...; ship the files it uses next to the app (fonts/<same subpath>) and point --font-dir at them
mkdir -p "$OUT/fonts/opentype/inter" "$OUT/fonts/truetype/dejavu" "$OUT/fonts/truetype/liberation" "$OUT/fonts/LICENSES"
for f in /usr/share/fonts/opentype/inter/Inter-*.otf; do cp "$f" "$OUT/fonts/opentype/inter/"; done
cp /usr/share/fonts/truetype/dejavu/DejaVu*.ttf "$OUT/fonts/truetype/dejavu/"; cp /usr/share/fonts/truetype/liberation/Liberation*.ttf "$OUT/fonts/truetype/liberation/"
for d in fonts-inter fonts-dejavu-core fonts-liberation; do [ -f /usr/share/doc/$d/copyright ] && cp /usr/share/doc/$d/copyright "$OUT/fonts/LICENSES/$d.txt"; done
mkdir -p "$OUT/sample" && printf 'hello vscode98\nline two\n' > "$OUT/sample/hello.txt" && printf '# sample\n' > "$OUT/sample/README.md"
sed 's/\r$//; s/$/\r/' "$S/11-windows-host/package/run-desktop.cmd" > "$OUT/run-desktop.cmd"
sed 's/\r$//; s/$/\r/' "$S/11-windows-host/package/reset-state.cmd" > "$OUT/reset-state.cmd"
# the same start with mimalloc as the JavaScript allocator (QJS98_MI=1), to compare the two on one machine
sed 's/\r$//; s/^set "QJS98_PROFILE=2"$/&\nset "QJS98_MI=1"/; s/$/\r/' "$S/11-windows-host/package/run-desktop.cmd" > "$OUT/run-desktop-mi.cmd"
grep -q QJS98_MI=1 "$OUT/run-desktop-mi.cmd"
sed 's/\r$//; s/$/\r/' "$S/11-windows-host/package/run-bench.cmd" > "$OUT/run-bench.cmd"; cp "$S/11-windows-host/package/bench.js" "$OUT/bench.js"
# the bytecode cache (05-child-process/host/esm.c, spike 14): boot the package once, headless, under Wine with the executable that ships, and keep only userdata/code-cache,
# so that the first start on the target reads the large bundles instead of compiling them (the cache renames the module paths to wherever the package is unpacked).
# PREBUILD_CACHE=0 skips it (the first start then writes the cache itself); the log of the boot is <outDir>.prebuild.log.
if [ "${PREBUILD_CACHE:-1}" != 0 ] && command -v wine >/dev/null && command -v winepath >/dev/null; then
  export WINEDEBUG=-all; W=$(winepath -w "$OUT"); WJ=$(winepath -w "$OUT/js" | tr '\\' /)
  ( cd "$OUT" && timeout 1200 wine "./qjs-win-$ARCH.exe" --stack-size 0 "$WJ/docs98/spikes/05-child-process/host/fork_main.mjs" "$WJ/s11" "$WJ/docs98/spikes/10-main-shim/host/boot_desktop_qjs.mjs" "$W\\app" --layout native --backend native --user-data-dir "$W\\userdata" --extensions-dir "$W\\userdata\\extensions" --workspace "$W\\sample" --seconds 120 --stable 300 ) > "$OUT.prebuild.log" 2>&1 || true
  if [ -d "$OUT/userdata/code-cache" ]; then mv "$OUT/userdata/code-cache" "$OUT/code-cache.tmp"; rm -rf "$OUT/userdata" "$OUT/results"; mkdir -p "$OUT/userdata"; mv "$OUT/code-cache.tmp" "$OUT/userdata/code-cache"; fi
  echo "code cache: $(ls "$OUT/userdata/code-cache" 2>/dev/null | wc -l) files, $(du -sh "$OUT/userdata/code-cache" 2>/dev/null | cut -f1) (prebuilt under Wine; log $OUT.prebuild.log)"
fi
echo "desktop package: $OUT ($(du -sh "$OUT" | cut -f1))"
