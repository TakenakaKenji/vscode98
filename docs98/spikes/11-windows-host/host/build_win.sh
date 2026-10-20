#!/usr/bin/env bash
# Cross-compiles the QuickJS-ng host for Windows with mingw-w64 (apt: gcc-mingw-w64-i686 / gcc-mingw-w64-x86-64) and links ONLY against system DLLs of Windows 7 / XP-era
# (kernel32, msvcrt, ws2_32, user32, gdi32): no runtime to install on the target. Statically links libgcc, no pthread DLL.
# Usage: bash build_win.sh <outDir> [x86|x64]      (QJS=<quickjs-ng source dir>; WINVER=0x0601 default = Windows 7, 0x0501 = XP)
# x86 build flags: -march=i586 -mno-sse -mno-sse2 -mno-mmx -mfpmath=387 (the baseline of spike 7).
set -euo pipefail
QJS=${QJS:-/home/user/quickjs-ng/quickjs}; OUT=$(mkdir -p "${1:?outDir}" && cd "$1" && pwd); ARCH=${2:-x86}; WINVER=${WINVER:-0x0601}
HERE=$(cd "$(dirname "$0")" && pwd); S5="$HERE/../../05-child-process/host"; S7="$HERE/../../07-native-render/host"; S4="$HERE/../../04-webassembly/host"; ONIG=${ONIG:-/home/user/kkos/oniguruma-08d3611}
if [ "$ARCH" = x86 ]; then CC=i686-w64-mingw32-gcc; FLAGS="-march=i586 -mno-sse -mno-sse2 -mno-mmx -mfpmath=387"; else CC=x86_64-w64-mingw32-gcc; FLAGS=""; fi
DEFS="-D_WIN32_WINNT=$WINVER -DWINVER=$WINVER -DNDEBUG -DWIN32_LEAN_AND_MEAN -D__USE_MINGW_ANSI_STDIO=0"
VER=$(sed -n 's/.*QJS_VERSION_MAJOR \([0-9]*\).*/\1/p' "$QJS/quickjs.h" | head -n1)
# quickjs-libc.c is compiled from a patched copy: an extra-waiters hook in the Windows poll loop (see patch_libc.py)
python3 "$HERE/patch_libc.py" "$QJS/quickjs-libc.c" "$OUT/quickjs-libc-win.c"
# quickjs.c with the hooks of the sampling profiler (07-native-render/host/prof98.h)
python3 "$S7/patch_quickjs.py" "$QJS/quickjs.c" "$OUT/quickjs.c"
sed 's|js_init_module_bjson(ctx, "qjs:bjson");|js_init_module_bjson(ctx, "qjs:bjson"); spike_init(ctx); spike_init_render(ctx); spike_init_layout(ctx); spike_init_style(ctx); spike_init_win(ctx); spike_init_onig(ctx);|; s|^\( *\)JS_SetModuleLoaderFunc2(rt, NULL, js_module_loader, js_module_check_attributes, NULL);|&\n\1spike_install_loader(rt);|; s|^\( *\)JS_SetHostPromiseRejectionTracker(rt, js_std_promise_rejection_tracker, NULL);|\1JS_SetHostPromiseRejectionTracker(rt, js_std_promise_rejection_tracker, NULL); spike_install_rejection_tracker(rt);|; 0,/^#include "quickjs-libc.h"/s||#include "quickjs-libc.h"\nvoid spike_init(JSContext *ctx);\nvoid spike_init_render(JSContext *ctx);\nvoid spike_init_layout(JSContext *ctx);\nvoid spike_init_style(JSContext *ctx);\nvoid spike_init_win(JSContext *ctx);\nvoid spike_init_onig(JSContext *ctx);\nvoid spike_install_loader(JSRuntime *rt);\nvoid spike_install_rejection_tracker(JSRuntime *rt);|' "$QJS/qjs.c" > "$OUT/qjs_patched.c"
# Oniguruma (TextMate grammars, syntax highlighting) compiled from source with the same flags; src/config.h.win32 is its own configuration for Windows
mkdir -p "$OUT/onig-$ARCH"; cp "$ONIG/src/config.h.win32" "$OUT/onig-$ARCH/config.h"
ONIGOBJ=""; for f in "$ONIG"/src/*.c; do b=$(basename "$f" .c); case $b in mktable|regposix|regposerr|unicode_egcb_data|unicode_fold_data|unicode_property_data|unicode_property_data_posix|unicode_wb_data) continue;; esac; o="$OUT/onig-$ARCH/$b.o"; if [ ! -f "$o" ] || [ "$f" -nt "$o" ]; then $CC $FLAGS $DEFS -O2 -I"$OUT/onig-$ARCH" -I"$ONIG/src" -DHAVE_CONFIG_H -c "$f" -o "$o"; fi; ONIGOBJ="$ONIGOBJ $o"; done
# mimalloc as the runtime's allocator (patch_quickjs.py): MIMALLOC=<mimalloc source dir with include/ and src/> (default /home/user/mimalloc), USE_MI=0 for the C library's malloc
MI=${MIMALLOC:-/home/user/mimalloc}; MIOBJ=""; MIDEF=""
if [ "${USE_MI:-1}" != 0 ] && [ -f "$MI/src/static.c" ]; then MIOBJ="$OUT/mimalloc-$ARCH.o"; MIDEF="-DUSE_MIMALLOC98 -I$MI/include"; if [ ! -f "$MIOBJ" ] || [ "$MI/src/static.c" -nt "$MIOBJ" ]; then $CC $FLAGS $DEFS -O2 -DMI_STATIC_LIB -I"$MI/include" -I"$MI/src" -c "$MI/src/static.c" -o "$MIOBJ"; fi; fi
SRC="$OUT/qjs_patched.c $OUT/quickjs-libc-win.c $OUT/quickjs.c $QJS/libregexp.c $QJS/libunicode.c $QJS/dtoa.c $QJS/gen/repl.c $QJS/gen/standalone.c $S5/esm.c $S7/render.c $S7/layout.c $S7/style.c $HERE/winproc.c $HERE/winwin.c $S4/onig_js.c $S4/onig_native.c $ONIGOBJ $MIOBJ"
$CC $FLAGS $DEFS $MIDEF -O2 -ffp-contract=off -fno-strict-aliasing -DONIG_NO_W2C -I"$QJS" -I"$HERE" -I"$S7" -I"$S4" -I"$ONIG/src" -o "$OUT/qjs-win-$ARCH.exe" $SRC -static-libgcc -lm -lws2_32 -luser32 -lgdi32 -ladvapi32 -lwinmm -lpsapi -lshell32 -Wl,--subsystem,console -Wl,--stack,268435456
echo "built $OUT/qjs-win-$ARCH.exe"
