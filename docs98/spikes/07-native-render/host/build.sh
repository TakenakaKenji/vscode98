#!/usr/bin/env bash
# Builds `qjs-spike7`: spike 5's host (stock QuickJS-ng qjs.c + proc.c + esm.c) plus the native rasterizer render.c (module `spike:render`).
# Usage: bash build.sh <outDir>   (QJS=<quickjs-ng source dir with a cmake build in build/>)
set -euo pipefail
QJS=${QJS:-/home/user/quickjs-ng/quickjs}; OUT=${1:?outDir}; HERE=$(cd "$(dirname "$0")" && pwd); S5="$HERE/../../05-child-process/host"
mkdir -p "$OUT"
sed 's|js_init_module_bjson(ctx, "qjs:bjson");|js_init_module_bjson(ctx, "qjs:bjson"); spike_init(ctx); spike_init_render(ctx);|; s|^\( *\)JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);|&\n\1spike_install_loader(rt);|; 0,/^#include "quickjs-libc.h"/s||#include "quickjs-libc.h"\nvoid spike_init(JSContext *ctx);\nvoid spike_init_render(JSContext *ctx);\nvoid spike_install_loader(JSRuntime *rt);|' "$QJS/qjs.c" > "$OUT/qjs_patched.c"
grep -q "spike_init_render(ctx);" "$OUT/qjs_patched.c" && grep -q "^ *spike_install_loader(rt);" "$OUT/qjs_patched.c" || { echo "patch did not apply" >&2; exit 1; }
# -ffp-contract=off: no fused multiply-add, so the C arithmetic matches JavaScript's double arithmetic operation for operation
gcc -O2 -g -DNDEBUG -ffp-contract=off -I"$QJS" -o "$OUT/qjs-spike7" "$OUT/qjs_patched.c" "$QJS/gen/repl.c" "$QJS/gen/standalone.c" "$S5/proc.c" "$S5/esm.c" "$HERE/render.c" -L"$QJS/build" -lqjs-libc -lqjs -lm -lpthread -ldl
echo "built $OUT/qjs-spike7"
