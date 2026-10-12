/* Registers everything this spike adds to the stock qjs context. Called from a one-line patch in a copy of qjs.c (see build.sh). */
#include "quickjs.h"
void spike_init_webassembly(JSContext *ctx);
void spike_init_onig(JSContext *ctx);
void spike_init(JSContext *ctx) {
	spike_init_webassembly(ctx);
	spike_init_onig(ctx);
}
