#!/usr/bin/env bash
# Builds `qjs-spike5`: stock QuickJS-ng `qjs` CLI (qjs.c copied and patched with ONE added line) + the `spike:proc` module (proc.c).
# Prerequisite: QuickJS-ng built with cmake in $QJS/build (or build32 with M32=1). Usage: bash build.sh <outDir>
set -euo pipefail
QJS=${QJS:-/home/user/quickjs-ng/quickjs}; OUT=${1:?outDir}; HERE=$(cd "$(dirname "$0")" && pwd)
BDIR=build; ARCH=""; if [ "${M32:-0}" = 1 ]; then BDIR=build32; ARCH=-m32; fi
mkdir -p "$OUT"
# patches: (1) call spike_init(ctx) when a context is created, (2) install the host module loader after main() installs the stock one
sed 's|js_init_module_bjson(ctx, "qjs:bjson");|js_init_module_bjson(ctx, "qjs:bjson"); spike_init(ctx);|; s|^\( *\)JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);|&\n\1spike_install_loader(rt);|; 0,/^#include "quickjs-libc.h"/s||#include "quickjs-libc.h"\nvoid spike_init(JSContext *ctx);\nvoid spike_install_loader(JSRuntime *rt);|' "$QJS/qjs.c" > "$OUT/qjs_patched.c"
grep -q "spike_init(ctx);" "$OUT/qjs_patched.c" \&\& grep -q "^ *spike_install_loader(rt);" "$OUT/qjs_patched.c" || { echo "patch did not apply" >&2; exit 1; }
gcc $ARCH -O2 -g -DNDEBUG -I"$QJS" -o "$OUT/qjs-spike5" "$OUT/qjs_patched.c" "$QJS/gen/repl.c" "$QJS/gen/standalone.c" "$HERE/proc.c" "$HERE/esm.c" -L"$QJS/$BDIR" -lqjs-libc -lqjs -lm -lpthread -ldl
echo "built $OUT/qjs-spike5"
