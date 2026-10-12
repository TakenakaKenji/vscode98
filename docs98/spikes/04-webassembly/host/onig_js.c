/* JS-facing OnigScanner / OnigString for QuickJS, shared by the native and wasm2c engines. Behaviour mirrors vscode-oniguruma 1.7.0's src/index.ts:
 *  - strings are UTF-8 inside the engine; offsets are mapped UTF-16 <-> UTF-8 (identity when the string is pure ASCII);
 *  - each OnigString gets a unique id used by the engine's per-string match cache;
 *  - findNextMatchSync(string | OnigString, startPosition, options) -> { index, captureIndices: [{start,end,length}] } | null.
 * Exposed as ES modules "spike:onig-native" and "spike:onig-wasm2c" (createOnigScanner, createOnigString, engine). */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "quickjs.h"
#include "onig_engine.h"

static JSClassID str_cid, scanner_cid;
static int g_next_id;

typedef struct { unsigned char *u8; int u8len, u16len; uint32_t *u16to8, *u8to16; int id; JSValue content; } OStr;
typedef struct { const OnigEngine *eng; void *handle; } OScanner;

static void ostr_free_data(OStr *o) { free(o->u8); free(o->u16to8); free(o->u8to16); o->u8 = NULL; o->u16to8 = o->u8to16 = NULL; }
static void ostr_finalizer(JSRuntime *rt, JSValue v) { OStr *o = JS_GetOpaque(v, str_cid); if (o) { ostr_free_data(o); JS_FreeValueRT(rt, o->content); free(o); } }
static void ostr_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark) { OStr *o = JS_GetOpaque(v, str_cid); if (o) { JS_MarkValue(rt, o->content, mark); } }
static JSClassDef str_class = { "OnigString", .finalizer = ostr_finalizer, .gc_mark = ostr_mark };

static void scanner_finalizer(JSRuntime *rt, JSValue v) { OScanner *s = JS_GetOpaque(v, scanner_cid); if (s) { if (s->handle) { s->eng->free_scanner(s->handle); } free(s); } }
static JSClassDef scanner_class = { "OnigScanner", .finalizer = scanner_finalizer };

/* Builds the UTF-8 copy and offset maps for a JS string. Returns NULL (with a pending exception) on failure. */
static OStr *ostr_new(JSContext *ctx, JSValueConst sv) {
	size_t len; const char *s = JS_ToCStringLen2(ctx, &len, sv, 0);
	if (!s) { return NULL; }
	OStr *o = calloc(1, sizeof *o);
	o->u8 = malloc(len ? len : 1); memcpy(o->u8, s, len); o->u8len = (int)len; o->id = ++g_next_id; o->content = JS_DupValue(ctx, sv);
	int u16 = 0; for (size_t i = 0; i < len;) { unsigned char c = (unsigned char)s[i]; int n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4; u16 += n == 4 ? 2 : 1; i += n; }
	o->u16len = u16;
	if (u16 != (int)len) {
		o->u16to8 = malloc(sizeof(uint32_t) * (u16 + 1)); o->u8to16 = malloc(sizeof(uint32_t) * (len + 1));
		int i16 = 0;
		for (size_t i = 0; i < len;) {
			unsigned char c = (unsigned char)s[i]; int n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
			for (int k = 0; k < n; k++) { o->u8to16[i + k] = i16; }
			o->u16to8[i16] = (uint32_t)i; if (n == 4) { o->u16to8[i16 + 1] = (uint32_t)i; i16 += 2; } else { i16++; }
			i += n;
		}
		o->u16to8[u16] = (uint32_t)len; o->u8to16[len] = (uint32_t)u16;
	}
	JS_FreeCString(ctx, s);
	return o;
}
static int to8(const OStr *o, int off) { if (!o->u16to8) { return off; } if (off < 0) { return 0; } if (off > o->u16len) { return o->u8len; } return (int)o->u16to8[off]; }
/* Offsets coming back from the engine are read as UNSIGNED, exactly like the reference wrapper (it reads them from a Uint32Array): a capture group that did not
 * participate (ONIG_REGION_NOTPOS = -1) therefore appears as 4294967295 for pure-ASCII strings and is clamped to the string length otherwise. */
static uint32_t to16(const OStr *o, uint32_t off) { if (!o->u8to16) { return off; } if (off > (uint32_t)o->u8len) { return (uint32_t)o->u16len; } return o->u8to16[off]; }

static JSValue ostr_content(JSContext *ctx, JSValueConst this_val) { OStr *o = JS_GetOpaque2(ctx, this_val, str_cid); return o ? JS_DupValue(ctx, o->content) : JS_EXCEPTION; }
static JSValue ostr_dispose(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { OStr *o = JS_GetOpaque2(ctx, this_val, str_cid); if (!o) { return JS_EXCEPTION; } ostr_free_data(o); return JS_UNDEFINED; }
static JSValue ostr_u8len(JSContext *ctx, JSValueConst this_val) { OStr *o = JS_GetOpaque2(ctx, this_val, str_cid); return o ? JS_NewInt32(ctx, o->u8len) : JS_EXCEPTION; }
static JSValue ostr_u16len(JSContext *ctx, JSValueConst this_val) { OStr *o = JS_GetOpaque2(ctx, this_val, str_cid); return o ? JS_NewInt32(ctx, o->u16len) : JS_EXCEPTION; }

static JSValue js_create_onig_string(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	if (argc < 1) { return JS_ThrowTypeError(ctx, "createOnigString(str): missing argument"); }
	OStr *o = ostr_new(ctx, argv[0]); if (!o) { return JS_EXCEPTION; }
	JSValue obj = JS_NewObjectClass(ctx, str_cid); JS_SetOpaque(obj, o); return obj;
}

static JSValue scanner_find(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	OScanner *sc = JS_GetOpaque2(ctx, this_val, scanner_cid); if (!sc) { return JS_EXCEPTION; }
	if (argc < 2) { return JS_ThrowTypeError(ctx, "findNextMatchSync(string, startPosition, options?)"); }
	OStr *o = JS_GetOpaque(argv[0], str_cid), *tmp = NULL;
	if (!o) { tmp = o = ostr_new(ctx, argv[0]); if (!o) { return JS_EXCEPTION; } }
	if (!o->u8) { return JS_ThrowTypeError(ctx, "OnigString was disposed"); }
	int32_t start = 0, options = 0;
	if (JS_ToInt32(ctx, &start, argv[1])) { goto fail; }
	if (argc > 2 && JS_IsNumber(argv[2]) && JS_ToInt32(ctx, &options, argv[2])) { goto fail; }
	const int *r = sc->eng->find(sc->handle, o->id, o->u8, o->u8len, to8(o, start), options);
	JSValue result = JS_NULL;
	if (r) {
		int count = r[1];
		JSValue caps = JS_NewArray(ctx);
		for (int i = 0; i < count; i++) {
			uint32_t b = to16(o, (uint32_t)r[2 + 2 * i]), e = to16(o, (uint32_t)r[3 + 2 * i]);
			JSValue c = JS_NewObject(ctx);
			JS_SetPropertyStr(ctx, c, "start", JS_NewUint32(ctx, b)); JS_SetPropertyStr(ctx, c, "end", JS_NewUint32(ctx, e)); JS_SetPropertyStr(ctx, c, "length", JS_NewInt64(ctx, (int64_t)e - (int64_t)b));
			JS_SetPropertyUint32(ctx, caps, (uint32_t)i, c);
		}
		result = JS_NewObject(ctx);
		JS_SetPropertyStr(ctx, result, "index", JS_NewInt32(ctx, r[0])); JS_SetPropertyStr(ctx, result, "captureIndices", caps);
	}
	if (tmp) { ostr_free_data(tmp); JS_FreeValue(ctx, tmp->content); free(tmp); }
	return result;
fail:
	if (tmp) { ostr_free_data(tmp); JS_FreeValue(ctx, tmp->content); free(tmp); }
	return JS_EXCEPTION;
}
static JSValue scanner_dispose(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	OScanner *sc = JS_GetOpaque2(ctx, this_val, scanner_cid); if (!sc) { return JS_EXCEPTION; }
	if (sc->handle) { sc->eng->free_scanner(sc->handle); sc->handle = NULL; }
	return JS_UNDEFINED;
}

static JSValue create_scanner(JSContext *ctx, const OnigEngine *eng, JSValueConst arr) {
	int64_t n; if (JS_GetLength(ctx, arr, &n) < 0) { return JS_EXCEPTION; }
	const unsigned char **pats = calloc((size_t)n + 1, sizeof *pats); int *lens = calloc((size_t)n + 1, sizeof *lens); const char **strs = calloc((size_t)n + 1, sizeof *strs);
	JSValue ret = JS_EXCEPTION; int64_t i;
	for (i = 0; i < n; i++) {
		JSValue v = JS_GetPropertyUint32(ctx, arr, (uint32_t)i); size_t l; strs[i] = JS_ToCStringLen2(ctx, &l, v, 0); JS_FreeValue(ctx, v);
		if (!strs[i]) { goto done; } pats[i] = (const unsigned char *)strs[i]; lens[i] = (int)l;
	}
	char err[256] = ""; void *h = eng->create_scanner(pats, lens, (int)n, err, sizeof err);
	if (!h) { ret = JS_ThrowInternalError(ctx, "%s", err[0] ? err : "failed to create OnigScanner"); goto done; }
	OScanner *sc = malloc(sizeof *sc); sc->eng = eng; sc->handle = h;
	ret = JS_NewObjectClass(ctx, scanner_cid); JS_SetOpaque(ret, sc);
done:
	for (int64_t k = 0; k < n; k++) { if (strs[k]) { JS_FreeCString(ctx, strs[k]); } }
	free(pats); free(lens); free(strs); return ret;
}

#define DEFINE_MODULE(NAME, ENGINE) \
	static JSValue NAME##_create_scanner(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { if (argc < 1) { return JS_ThrowTypeError(ctx, "createOnigScanner(patterns)"); } return create_scanner(ctx, &ENGINE, argv[0]); } \
	static int NAME##_init(JSContext *ctx, JSModuleDef *m) { \
		if (ENGINE.init()) { return -1; } \
		JS_SetModuleExport(ctx, m, "createOnigScanner", JS_NewCFunction(ctx, NAME##_create_scanner, "createOnigScanner", 1)); \
		JS_SetModuleExport(ctx, m, "createOnigString", JS_NewCFunction(ctx, js_create_onig_string, "createOnigString", 1)); \
		JS_SetModuleExport(ctx, m, "engine", JS_NewString(ctx, ENGINE.name)); \
		return 0; }

DEFINE_MODULE(native, onig_engine_native)
DEFINE_MODULE(wasm2c, onig_engine_wasm2c)

static const JSCFunctionListEntry str_funcs[] = { JS_CGETSET_DEF("content", ostr_content, NULL), JS_CGETSET_DEF("utf8Length", ostr_u8len, NULL), JS_CGETSET_DEF("utf16Length", ostr_u16len, NULL), JS_CFUNC_DEF("dispose", 0, ostr_dispose) };
static const JSCFunctionListEntry scanner_funcs[] = { JS_CFUNC_DEF("findNextMatchSync", 3, scanner_find), JS_CFUNC_DEF("dispose", 0, scanner_dispose) };

static void add_module(JSContext *ctx, const char *name, JSModuleInitFunc *init) {
	JSModuleDef *m = JS_NewCModule(ctx, name, init); if (!m) { return; }
	JS_AddModuleExport(ctx, m, "createOnigScanner"); JS_AddModuleExport(ctx, m, "createOnigString"); JS_AddModuleExport(ctx, m, "engine");
}
void spike_init_onig(JSContext *ctx) {
	JSRuntime *rt = JS_GetRuntime(ctx);
	JS_NewClassID(rt, &str_cid); JS_NewClassID(rt, &scanner_cid);
	JS_NewClass(rt, str_cid, &str_class); JS_NewClass(rt, scanner_cid, &scanner_class);
	JSValue sp = JS_NewObject(ctx); JS_SetPropertyFunctionList(ctx, sp, str_funcs, sizeof str_funcs / sizeof *str_funcs); JS_SetClassProto(ctx, str_cid, sp);
	JSValue cp = JS_NewObject(ctx); JS_SetPropertyFunctionList(ctx, cp, scanner_funcs, sizeof scanner_funcs / sizeof *scanner_funcs); JS_SetClassProto(ctx, scanner_cid, cp);
	add_module(ctx, "spike:onig-native", native_init); add_module(ctx, "spike:onig-wasm2c", wasm2c_init);
}
