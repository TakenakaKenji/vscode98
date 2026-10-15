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
          "            if (list_empty(&ts->os_rw_handlers) && list_empty(&ts->port_list) && !(js_win_waiter.active && js_win_waiter.active()) && !(js_win_waiter.wants_messages && js_win_waiter.wants_messages()))\n                return -1; /* no more events */", "static int js_os_poll_internal")
src = sub("    if (count > 0) {\n        DWORD ret, timeout = INFINITE;",
          "    if (js_win_waiter.collect && count < (int)countof(handles) - 1)\n        count += js_win_waiter.collect(handles + count, (int)countof(handles) - 1 - count);   /* MsgWaitForMultipleObjects takes at most 63 */\n    int has_windows = js_win_waiter.wants_messages && js_win_waiter.wants_messages();\n    if (count > 0 || has_windows) {\n        DWORD ret, timeout = INFINITE;", "static int js_os_poll_internal")
src = sub("        ret = WaitForMultipleObjects(count, handles, FALSE, timeout);\n",
          "        if (js_win_waiter.max_timeout) { int mt = js_win_waiter.max_timeout(); if (mt >= 0 && (timeout == INFINITE || timeout > (DWORD)mt)) timeout = mt; }\n        ret = has_windows ? MsgWaitForMultipleObjects(count, handles, FALSE, timeout, QS_ALLINPUT) : WaitForMultipleObjects(count, handles, FALSE, timeout);\n        if (has_windows && ret == WAIT_OBJECT_0 + (DWORD)count) { js_win_waiter.pump(ctx); goto done; }\n", "static int js_os_poll_internal")
src = sub("        if (ret < (DWORD)count) {\n",
          "        if (ret < (DWORD)count && js_win_waiter.dispatch) {\n            int r = js_win_waiter.dispatch(ctx, handles[ret]);\n            if (r < 0) return -1;\n            if (r > 0) goto done;\n        }\n        if (ret < (DWORD)count) {\n", "static int js_os_poll_internal")
# js_load_file reads in 8 KB pieces and reallocates (len + n + 1) after every one: linear growth, so a 15 MB bundle means 1,900 reallocations, and where realloc has to move large blocks (the Windows
# heap) that is quadratic copying (seconds under Wine, much worse on a VM). Read a file of known size with one allocation; unknown sizes (pipes, devices) grow geometrically.
lf = src.index("uint8_t *js_load_file(JSContext *ctx, size_t *pbuf_len, const char *filename)\n{")
le = src.index("\n}\n", lf) + 3
src = src[:lf] + """uint8_t *js_load_file(JSContext *ctx, size_t *pbuf_len, const char *filename)
{
    FILE *f;
    size_t n, len = 0, cap = 0;
    uint8_t *p, *buf = NULL;
    long size = -1;

    f = fopen(filename, "rb");
    if (!f)
        return NULL;
    if (fseek(f, 0, SEEK_END) == 0) {
        size = ftell(f);
        if (fseek(f, 0, SEEK_SET) != 0)
            size = -1;
    }
    cap = size >= 0 ? (size_t)size + 1 : 65536;
    for (;;) {
        if (len + 1 >= cap)
            cap *= 2;
        p = ctx ? js_realloc(ctx, buf, cap) : realloc(buf, cap);
        if (!p) {
            if (ctx) js_free(ctx, buf); else free(buf);
            fclose(f);
            return NULL;
        }
        buf = p;
        n = fread(buf + len, 1, cap - len - 1, f);
        len += n;
        if (n == 0 || (size >= 0 && len >= (size_t)size))
            break;
    }
    fclose(f);
    buf[len] = '\\0';
    *pbuf_len = len;
    return buf;
}
""" + src[le:]
# the header and the table definition go right after the first #include of the file
k = src.index('#include "quickjs-libc.h"')
k = src.index("\n", k) + 1
src = src[:k] + '#ifdef _WIN32\n#include "winhook.h"\nJSWinWaiter js_win_waiter;\n#endif\n' + src[k:]
open(sys.argv[2], "w").write(src)
