#!/usr/bin/env bash
# Builds `qjs-spike4`: the stock QuickJS-ng `qjs` CLI (qjs.c copied and patched with ONE added line) plus the spike's extensions:
#   - a WebAssembly JS API on the wasm3 interpreter                          (wasm3_js.c)
#   - native Oniguruma 6.9.8 as an OnigScanner/OnigString module              (onig_native.c + onig_js.c)  -> import "spike:onig-native"
#   - onig.wasm translated to C by wasm2c, same JS module surface            (onig_w2c.c + generated onig.c) -> import "spike:onig-wasm2c"
# Prerequisites (built beforehand): QuickJS-ng with cmake in $QJS/build; wasm3 in $W3/build; Oniguruma 6.9.8 (commit 08d3611, the one vscode-oniguruma 1.7.0 pins) in $ONIG/build;
# wabt (wasm2c + /usr/include/wasm-rt.h + /usr/share/wabt/wasm2c/wasm-rt-impl.c). Usage: bash build.sh <outDir> [path/to/onig.wasm]
set -euo pipefail
QJS=${QJS:-/home/user/quickjs-ng/quickjs}; W3=${W3:-/home/user/wasm3/wasm3}; ONIG=${ONIG:-/home/user/kkos/oniguruma-08d3611}
WASM=${2:-/home/user/vscode98/node_modules/vscode-oniguruma/release/onig.wasm}; OUT=${1:?outDir}; HERE=$(cd "$(dirname "$0")" && pwd); RT=/usr/share/wabt/wasm2c
mkdir -p "$OUT"
sed 's|js_init_module_bjson(ctx, "qjs:bjson");|js_init_module_bjson(ctx, "qjs:bjson"); spike_init(ctx);|; 0,/^#include "quickjs-libc.h"/s||#include "quickjs-libc.h"\nvoid spike_init(JSContext *ctx);|' "$QJS/qjs.c" > "$OUT/qjs_patched.c"
grep -q "spike_init(ctx);" "$OUT/qjs_patched.c" || { echo "patch did not apply" >&2; exit 1; }
# onig.wasm -> C (once; the generated file is 4.4 MB and is not committed)
[ -f "$OUT/onig.c" ] || wasm2c "$WASM" -o "$OUT/onig.c" --module-name onig
CFLAGS="-O2 -g -DNDEBUG -I$QJS -I$W3/source -I$ONIG/src -I$OUT -I$RT -I$HERE"
[ -f "$OUT/onig_wasm.o" ] || gcc -O2 -c "$OUT/onig.c" -I"$OUT" -I"$RT" -o "$OUT/onig_wasm.o"      # slow: ~1-2 minutes
[ -f "$OUT/wasm-rt-impl.o" ] || gcc -O2 -c "$RT/wasm-rt-impl.c" -I"$RT" -o "$OUT/wasm-rt-impl.o"
[ -f "$OUT/wasm-rt-exceptions-impl.o" ] || gcc -O2 -c "$RT/wasm-rt-exceptions-impl.c" -I"$RT" -o "$OUT/wasm-rt-exceptions-impl.o"
LIBS="-L$QJS/build -lqjs-libc -lqjs -L$W3/build/source -lm3 $ONIG/build/libonig.a -lm -lpthread -ldl"
gcc $CFLAGS -o "$OUT/qjs-spike4" "$OUT/qjs_patched.c" "$QJS/gen/repl.c" "$QJS/gen/standalone.c" \
	"$HERE/spike_modules.c" "$HERE/wasm3_js.c" "$HERE/onig_js.c" "$HERE/onig_native.c" "$HERE/onig_w2c.c" "$OUT/onig_wasm.o" "$OUT/wasm-rt-impl.o" "$OUT/wasm-rt-exceptions-impl.o" $LIBS
echo "built $OUT/qjs-spike4"
