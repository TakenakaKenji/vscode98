/* Base64 <-> bytes, native (included by proc.c and 11-windows-host/host/winproc.c). Our IPC is JSON lines, so every binary message (all of VS Code's
 * channel traffic is VSBuffers) travels as base64 (10-main-shim/host/codec98.js). The JS loops were the largest single cost of the laptop's v22 launch
 * profile: 12 % of the window process, 47 % of main, 36 % of the shared process. Installed as globals (__base64Encode / __base64Decode) like the
 * UTF-8 routines, so codec98.js can use them without importing a host module (it also runs on Node). Same results as the JS versions. Also __fnv1a64 (below). */
#include <stdint.h>
#include <stdlib.h>
#include "quickjs.h"

static const char b64_alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* __base64Encode(typedArrayOrArrayBuffer) -> string */
static JSValue js_b64_encode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t byteoff = 0, bytelen = 0, bpe = 0, size = 0; uint8_t *p; JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &byteoff, &bytelen, &bpe);
	if (!JS_IsException(ab)) { p = JS_GetArrayBuffer(ctx, &size, ab); JS_FreeValue(ctx, ab); if (!p) { return JS_EXCEPTION; } p += byteoff; }
	else { JS_FreeValue(ctx, JS_GetException(ctx)); p = JS_GetArrayBuffer(ctx, &size, argv[0]); if (!p) { return JS_EXCEPTION; } bytelen = size; }
	size_t outlen = (bytelen + 2) / 3 * 4; char *out = malloc(outlen + 1); if (!out) { return JS_ThrowOutOfMemory(ctx); }
	size_t i = 0, o = 0;
	for (; i + 2 < bytelen; i += 3) {
		uint32_t v = ((uint32_t)p[i] << 16) | ((uint32_t)p[i + 1] << 8) | p[i + 2];
		out[o++] = b64_alphabet[(v >> 18) & 63]; out[o++] = b64_alphabet[(v >> 12) & 63]; out[o++] = b64_alphabet[(v >> 6) & 63]; out[o++] = b64_alphabet[v & 63];
	}
	if (i < bytelen) {
		uint32_t v = ((uint32_t)p[i] << 16) | ((i + 1 < bytelen ? (uint32_t)p[i + 1] : 0) << 8);
		out[o++] = b64_alphabet[(v >> 18) & 63]; out[o++] = b64_alphabet[(v >> 12) & 63]; out[o++] = i + 1 < bytelen ? b64_alphabet[(v >> 6) & 63] : '='; out[o++] = '=';
	}
	JSValue r = JS_NewStringLen(ctx, out, o); free(out); return r;
}

/* __base64Decode(string) -> Uint8Array. Like the JS version: characters outside the alphabet count as 0, a trailing '=' or '==' shortens the result. */
static JSValue js_b64_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	static int8_t rev[256]; static int rev_ready;
	if (!rev_ready) { for (int k = 0; k < 64; k++) { rev[(unsigned char)b64_alphabet[k]] = (int8_t)k; } rev_ready = 1; }
	size_t len; const char *s = JS_ToCStringLen2(ctx, &len, argv[0], 0); if (!s) { return JS_EXCEPTION; }
	/* non-ASCII (never in what we encode): count UTF-16 units like the JS version does, each one outside the alphabet */
	char *units = NULL;
	for (size_t i = 0; i < len; i++) { if ((unsigned char)s[i] >= 0x80) {
		units = malloc(len * 2 + 1); if (!units) { JS_FreeCString(ctx, s); return JS_ThrowOutOfMemory(ctx); }
		size_t u = 0; for (size_t k = 0; k < len; ) { unsigned char c = (unsigned char)s[k];
			if (c < 0x80) { units[u++] = (char)c; k++; } else { int n = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1; units[u++] = '!'; if (n == 4) { units[u++] = '!'; } k += n; } }
		JS_FreeCString(ctx, s); s = units; len = u; break;
	} }
	size_t pad = len >= 2 && s[len - 1] == '=' && s[len - 2] == '=' ? 2 : len >= 1 && s[len - 1] == '=' ? 1 : 0;
	size_t n = len / 4 * 3 + (len % 4 ? (len % 4) * 3 / 4 : 0); n = n >= pad ? n - pad : 0;
	uint8_t *out = malloc(n ? n : 1); if (!out) { if (units) { free(units); } else { JS_FreeCString(ctx, s); } return JS_ThrowOutOfMemory(ctx); }
	size_t o = 0;
	for (size_t i = 0; i < len && o < n; i += 4) {
		uint32_t v = 0;
		for (int k = 0; k < 4; k++) { v <<= 6; if (i + k < len) { v |= (uint32_t)rev[(unsigned char)s[i + k]]; } }
		out[o++] = (v >> 16) & 255; if (o < n) { out[o++] = (v >> 8) & 255; } if (o < n) { out[o++] = v & 255; }
	}
	if (units) { free(units); } else { JS_FreeCString(ctx, s); }
	JSValue r = JS_NewUint8ArrayCopy(ctx, out, n); free(out); return r;
}

/* __fnv1a64(string) -> 16 hex digits: FNV-1a 64 of the UTF-8 bytes; keys of caches made from large texts (the style analysis store, 06-rendering/host/dom/style_invalidation.js) */
static JSValue js_fnv1a64(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len; const char *s = JS_ToCStringLen2(ctx, &len, argv[0], 0); if (!s) { return JS_EXCEPTION; }
	uint64_t h = 14695981039346656037ull; for (size_t i = 0; i < len; i++) { h ^= (unsigned char)s[i]; h *= 1099511628211ull; }
	JS_FreeCString(ctx, s); char out[17]; static const char hx[] = "0123456789abcdef"; for (int i = 0; i < 16; i++) { out[15 - i] = hx[(h >> (4 * i)) & 15]; } return JS_NewStringLen(ctx, out, 16);
}
static void js98_b64_install(JSContext *ctx) {
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__base64Encode", JS_NewCFunction(ctx, js_b64_encode, "__base64Encode", 1));
	JS_SetPropertyStr(ctx, g, "__base64Decode", JS_NewCFunction(ctx, js_b64_decode, "__base64Decode", 1));
	JS_SetPropertyStr(ctx, g, "__fnv1a64", JS_NewCFunction(ctx, js_fnv1a64, "__fnv1a64", 1));
	JS_FreeValue(ctx, g);
}
