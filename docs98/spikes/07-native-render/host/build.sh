#!/usr/bin/env bash
# Builds `qjs-spike7`: spike 5's host (stock QuickJS-ng qjs.c + proc.c + esm.c) plus the native rasterizer render.c (module `spike:render`).
# Includes native Oniguruma (module spike:onig-native; ONIG=<oniguruma source dir with build/libonig.a or build32/libonig.a>).
# Usage: bash build.sh <outDir>   (QJS=<quickjs-ng source dir with a cmake build in build/>)
set -euo pipefail
QJS=${QJS:-/home/user/quickjs-ng/quickjs}; ONIG=${ONIG:-/home/user/kkos/oniguruma-08d3611}; S4="$(cd "$(dirname "$0")" && pwd)/../../04-webassembly/host"; OUT=${1:?outDir}; HERE=$(cd "$(dirname "$0")" && pwd); S5="$HERE/../../05-child-process/host"
BDIR=build; ARCH=""; if [ "${M32:-0}" = 1 ]; then BDIR=build32; ARCH=-m32; fi   # M32=1: 32-bit x86 build (needs the QuickJS build32 tree)
mkdir -p "$OUT"
sed 's|js_init_module_bjson(ctx, "qjs:bjson");|js_init_module_bjson(ctx, "qjs:bjson"); spike_init(ctx); spike_init_render(ctx); spike_init_layout(ctx); spike_init_onig(ctx);|; s|^\( *\)JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);|&\n\1spike_install_loader(rt);|; s|^\( *\)JS_SetHostPromiseRejectionTracker(rt, js_std_promise_rejection_tracker, NULL);|\1JS_SetHostPromiseRejectionTracker(rt, js_std_promise_rejection_tracker, NULL); spike_install_rejection_tracker(rt);|; 0,/^#include "quickjs-libc.h"/s||#include "quickjs-libc.h"\nvoid spike_init(JSContext *ctx);\nvoid spike_init_render(JSContext *ctx);\nvoid spike_init_layout(JSContext *ctx);\nvoid spike_init_onig(JSContext *ctx);\nvoid spike_install_loader(JSRuntime *rt);\nvoid spike_install_rejection_tracker(JSRuntime *rt);|' "$QJS/qjs.c" > "$OUT/qjs_patched.c"
grep -q "spike_init_layout(ctx);" "$OUT/qjs_patched.c" && grep -q "^ *spike_install_loader(rt);" "$OUT/qjs_patched.c" || { echo "patch did not apply" >&2; exit 1; }
# -ffp-contract=off: no fused multiply-add, so the C arithmetic matches JavaScript's double arithmetic operation for operation
gcc $ARCH ${CFLAGS_EXTRA:-} -O2 -g -DNDEBUG -ffp-contract=off -I"$QJS" -o "$OUT/qjs-spike7" "$OUT/qjs_patched.c" "$QJS/gen/repl.c" "$QJS/gen/standalone.c" "$S5/proc.c" "$S5/esm.c" "$HERE/render.c" "$HERE/layout.c" -DONIG_NO_W2C -I"$ONIG/src" -I"$S4" "$S4/onig_js.c" "$S4/onig_native.c" "$ONIG/$BDIR/libonig.a" -L"$QJS/$BDIR" -lqjs-libc -lqjs -lm -lpthread -ldl
echo "built $OUT/qjs-spike7"
