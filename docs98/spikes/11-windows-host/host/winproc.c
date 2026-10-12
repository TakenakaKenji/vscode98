/* spike:proc for Windows (stage 0: only what is portable; the process / pipe layer follows). */
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include "quickjs.h"
#include "winhook.h"
void spike_init_esm(JSContext *ctx);
static JSValue js_utf8_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t byteoff = 0, bytelen = 0, bpe = 0, size = 0; uint8_t *p; JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &byteoff, &bytelen, &bpe);
	if (!JS_IsException(ab)) { p = JS_GetArrayBuffer(ctx, &size, ab); JS_FreeValue(ctx, ab); if (!p) { return JS_EXCEPTION; } p += byteoff; }
	else { JS_FreeValue(ctx, JS_GetException(ctx)); p = JS_GetArrayBuffer(ctx, &size, argv[0]); if (!p) { return JS_EXCEPTION; } bytelen = size; }
	return JS_NewStringLen(ctx, (const char *)p, bytelen);
}
static JSValue js_utf8_encode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len; const char *s = JS_ToCStringLen2(ctx, &len, argv[0], 0); if (!s) { return JS_EXCEPTION; }
	JSValue r = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)s, len); JS_FreeCString(ctx, s); return r;
}
void spike_init(JSContext *ctx) {
	spike_init_esm(ctx);
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__utf8Decode", JS_NewCFunction(ctx, js_utf8_decode, "__utf8Decode", 1));
	JS_SetPropertyStr(ctx, g, "__utf8Encode", JS_NewCFunction(ctx, js_utf8_encode, "__utf8Encode", 1));
	JS_FreeValue(ctx, g);
}
