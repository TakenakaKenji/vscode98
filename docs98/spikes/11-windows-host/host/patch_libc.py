#!/usr/bin/env python3
"""Writes a copy of QuickJS-ng's quickjs-libc.c whose Windows poll loop also waits on the handles of js_win_waiter (winhook.h). Usage: patch_libc.py <in> <out>"""
import sys
src = open(sys.argv[1]).read()
def sub(old, new, after):
    i = src.index(after); j = src.index(old, i)
    return src[:j] + new + src[j + len(old):]
a = "static int js_os_poll_internal(JSContext *ctx, int timeout_ms, int flags)\n{\n    JSRuntime *rt = JS_GetRuntime(ctx);"
assert a in src
win = src.index("#if defined(_WIN32)\nstatic int js_os_poll_internal")
src = sub("            if (list_empty(&ts->os_rw_handlers) && list_empty(&ts->port_list))\n                return -1; /* no more events */",
          "            if (list_empty(&ts->os_rw_handlers) && list_empty(&ts->port_list) && !(js_win_waiter.active && js_win_waiter.active()))\n                return -1; /* no more events */", "static int js_os_poll_internal")
src = sub("    if (count > 0) {\n        DWORD ret, timeout = INFINITE;",
          "    if (js_win_waiter.collect && count < (int)countof(handles))\n        count += js_win_waiter.collect(handles + count, (int)countof(handles) - count);\n    if (count > 0) {\n        DWORD ret, timeout = INFINITE;", "static int js_os_poll_internal")
src = sub("        if (ret < (DWORD)count) {\n",
          "        if (ret < (DWORD)count && js_win_waiter.dispatch) {\n            int r = js_win_waiter.dispatch(ctx, handles[ret]);\n            if (r < 0) return -1;\n            if (r > 0) goto done;\n        }\n        if (ret < (DWORD)count) {\n", "static int js_os_poll_internal")
# the header and the table definition go right after the first #include of the file
k = src.index('#include "quickjs-libc.h"')
k = src.index("\n", k) + 1
src = src[:k] + '#ifdef _WIN32\n#include "winhook.h"\nJSWinWaiter js_win_waiter;\n#endif\n' + src[k:]
open(sys.argv[2], "w").write(src)
