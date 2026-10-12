/* Extra waitable handles for QuickJS's Windows event loop. The stock loop (quickjs-libc.c, js_os_poll_internal) only waits on stdin and worker ports; pipes, sockets
 * and child processes cannot be waited on through os.setReadHandler there. The patched libc (patch_libc.py) asks this table for more handles on every poll. */
#ifndef WINHOOK_H
#define WINHOOK_H
#include <windows.h>
#include "quickjs.h"
typedef struct JSWinWaiter {
	int (*collect)(HANDLE *out, int max);                 /* append waitable handles, return how many */
	int (*dispatch)(JSContext *ctx, HANDLE signalled);    /* a collected handle was signalled; return 1 if it was handled here, -1 on a JS exception */
	int (*active)(void);                                  /* nonzero while something can still produce events (keeps the loop alive) */
} JSWinWaiter;
extern JSWinWaiter js_win_waiter;
#endif
