#!/usr/bin/env bash
# Builds the baseline binary: QuickJS-ng, the spike 5 shims and both native modules for a Pentium-class x87 CPU (no SSE/SSE2, no MMX, no CMOV), 32-bit x86,
# then verifies the instruction set. Needs gcc with 32-bit support (gcc-multilib) and cmake.  Usage: bash build_baseline.sh <outDir>
# Flags: -m32 -march=i586 -mno-sse -mno-sse2 -mno-mmx -mfpmath=387 ; render.c sets the x87 precision control to 53 bits at start-up.
set -euo pipefail
QJS=${QJS:-/home/user/quickjs-ng/quickjs}; OUT=$(mkdir -p "${1:?outDir}" && cd "$1" && pwd); HERE=$(cd "$(dirname "$0")" && pwd); S5="$HERE/../../05-child-process/host"
FLAGS="-m32 -march=i586 -mno-sse -mno-sse2 -mno-mmx -mfpmath=387"
mkdir -p "$OUT/qjs-build" && (cd "$OUT/qjs-build" && cmake "$QJS" -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_EXE_LINKER_FLAGS=-m32 >/dev/null && make -j4 qjs-libc qjs >/dev/null)
sed 's|js_init_module_bjson(ctx, "qjs:bjson");|js_init_module_bjson(ctx, "qjs:bjson"); spike_init(ctx); spike_init_render(ctx); spike_init_layout(ctx);|; s|^\( *\)JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);|&\n\1spike_install_loader(rt);|; 0,/^#include "quickjs-libc.h"/s||#include "quickjs-libc.h"\nvoid spike_init(JSContext *ctx);\nvoid spike_init_render(JSContext *ctx);\nvoid spike_init_layout(JSContext *ctx);\nvoid spike_install_loader(JSRuntime *rt);|' "$QJS/qjs.c" > "$OUT/qjs_patched.c"
gcc $FLAGS -O2 -DNDEBUG -ffp-contract=off -I"$QJS" -o "$OUT/qjs-spike7" "$OUT/qjs_patched.c" "$QJS/gen/repl.c" "$QJS/gen/standalone.c" "$S5/proc.c" "$S5/esm.c" "$HERE/render.c" "$HERE/layout.c" -L"$OUT/qjs-build" -lqjs-libc -lqjs -lm -lpthread -ldl
echo "built $OUT/qjs-spike7"; bash "$HERE/check_isa.sh" "$OUT/qjs-spike7"
