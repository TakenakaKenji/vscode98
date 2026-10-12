/* Spike 4: a minimal WebAssembly JavaScript API for QuickJS-ng, implemented on the wasm3 interpreter.
 * Enough for Emscripten-built modules that use WebAssembly.instantiate(bytes, imports): Module, Instance, Memory (buffer/grow), Table (length/get),
 * RuntimeError/CompileError/LinkError, instantiate/compile/validate. Not implemented: Global objects, table set/grow, shared memory, imported
 * memories/tables/globals, multi-value returns from imports, exceptions, streaming APIs.
 */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "quickjs.h"
#include "wasm3.h"
#include "m3_env.h"
#include "m3_function.h"
#include "m3_compile.h"

static JSClassID module_cid, instance_cid, memory_cid, table_cid;
static IM3Environment g_env;

typedef struct { uint8_t *bytes; size_t len; } WModule;

typedef struct Instance {
	JSContext *ctx;
	IM3Runtime rt;
	IM3Module mod;
	uint8_t *bytes;            /* wasm3 keeps pointing at the module bytes: keep a private copy alive */
	JSValue pending_exc;       /* exception thrown by a JS import, rethrown when the wasm call returns */
	int has_exc;
	JSValue *import_fns; int n_import_fns;
} Instance;

typedef struct { JSValue instance; uint32_t index; JSValue buffer; uint8_t *buf_ptr; size_t buf_len; } WMemory;
typedef struct { JSValue instance; uint32_t index; } WTable;

typedef struct { Instance *inst; JSValue fn; IM3FuncType type; } ImportCtx;

/* ---------- error helpers ---------- */
static JSValue throw_wasm_error(JSContext *ctx, const char *cls, const char *msg) {
	JSValue g = JS_GetGlobalObject(ctx), wa = JS_GetPropertyStr(ctx, g, "WebAssembly");
	JSValue C = JS_GetPropertyStr(ctx, wa, cls);
	JSValue err = JS_CallConstructor(ctx, C, 1, (JSValueConst[]){ JS_NewString(ctx, msg) });
	JS_FreeValue(ctx, C); JS_FreeValue(ctx, wa); JS_FreeValue(ctx, g);
	return JS_Throw(ctx, err);
}

/* ---------- Module ---------- */
static void module_finalizer(JSRuntime *rt, JSValue v) { WModule *m = JS_GetOpaque(v, module_cid); if (m) { free(m->bytes); free(m); } }
static JSClassDef module_class = { "WebAssembly.Module", .finalizer = module_finalizer };

static int get_bytes(JSContext *ctx, JSValueConst v, uint8_t **out, size_t *len) {
	size_t size;
	uint8_t *p = JS_GetArrayBuffer(ctx, &size, v);
	if (p) { *out = p; *len = size; return 0; }
	JS_FreeValue(ctx, JS_GetException(ctx));
	size_t off, blen, bpe; JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &blen, &bpe);
	if (JS_IsException(ab)) { JS_FreeValue(ctx, JS_GetException(ctx)); return -1; }
	p = JS_GetArrayBuffer(ctx, &size, ab); JS_FreeValue(ctx, ab);
	if (!p) { return -1; }
	*out = p + off; *len = blen; return 0;
}

static JSValue module_ctor(JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv) {
	uint8_t *p; size_t n;
	if (argc < 1 || get_bytes(ctx, argv[0], &p, &n) < 0) { return JS_ThrowTypeError(ctx, "WebAssembly.Module(): argument must be a buffer source"); }
	/* validate by parsing once */
	IM3Module probe; M3Result r = m3_ParseModule(g_env, &probe, p, (uint32_t)n);
	if (r) { return throw_wasm_error(ctx, "CompileError", r); }
	m3_FreeModule(probe);
	WModule *m = calloc(1, sizeof *m); m->bytes = malloc(n); memcpy(m->bytes, p, n); m->len = n;
	JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
	JSValue obj = JS_NewObjectProtoClass(ctx, proto, module_cid); JS_FreeValue(ctx, proto);
	JS_SetOpaque(obj, m);
	return obj;
}

/* ---------- Memory ---------- */
static void memory_finalizer(JSRuntime *rt, JSValue v) { WMemory *m = JS_GetOpaque(v, memory_cid); if (m) { JS_FreeValueRT(rt, m->instance); JS_FreeValueRT(rt, m->buffer); free(m); } }
static void memory_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark) { WMemory *m = JS_GetOpaque(v, memory_cid); if (m) { JS_MarkValue(rt, m->instance, mark); JS_MarkValue(rt, m->buffer, mark); } }
static JSClassDef memory_class = { "WebAssembly.Memory", .finalizer = memory_finalizer, .gc_mark = memory_mark };

static Instance *mem_instance(JSContext *ctx, WMemory *m) { return JS_GetOpaque(m->instance, instance_cid); }

static JSValue memory_buffer(JSContext *ctx, JSValueConst this_val) {
	WMemory *m = JS_GetOpaque2(ctx, this_val, memory_cid); if (!m) { return JS_EXCEPTION; }
	Instance *in = mem_instance(ctx, m);
	size_t size; uint8_t *p = m3_GetMemory(in->mod, &size, m->index);
	if (JS_IsUndefined(m->buffer) || p != m->buf_ptr || size != m->buf_len) {   /* first use, or the memory grew/moved: new ArrayBuffer, old one detached */
		if (!JS_IsUndefined(m->buffer)) { JS_DetachArrayBuffer(ctx, m->buffer); JS_FreeValue(ctx, m->buffer); }
		m->buffer = JS_NewArrayBuffer(ctx, p, size, 0, NULL, NULL, 0);
		m->buf_ptr = p; m->buf_len = size;
	}
	return JS_DupValue(ctx, m->buffer);
}

static JSValue memory_grow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	WMemory *m = JS_GetOpaque2(ctx, this_val, memory_cid); if (!m) { return JS_EXCEPTION; }
	Instance *in = mem_instance(ctx, m);
	uint32_t delta = 0; if (argc > 0 && JS_ToUint32(ctx, &delta, argv[0])) { return JS_EXCEPTION; }
	IM3Memory mem = in->mod->memories[m->index];
	uint64_t old = mem->numPages;
	M3Result r = ResizeMemory(in->rt, mem, old + delta);
	if (r) { return JS_ThrowRangeError(ctx, "WebAssembly.Memory.grow(): failed to grow memory (%s)", r); }
	if (!JS_IsUndefined(m->buffer)) { JS_DetachArrayBuffer(ctx, m->buffer); JS_FreeValue(ctx, m->buffer); m->buffer = JS_UNDEFINED; }
	return JS_NewInt64(ctx, (int64_t)old);
}

/* ---------- Table ---------- */
static void table_finalizer(JSRuntime *rt, JSValue v) { WTable *t = JS_GetOpaque(v, table_cid); if (t) { JS_FreeValueRT(rt, t->instance); free(t); } }
static void table_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark) { WTable *t = JS_GetOpaque(v, table_cid); if (t) { JS_MarkValue(rt, t->instance, mark); } }
static JSClassDef table_class = { "WebAssembly.Table", .finalizer = table_finalizer, .gc_mark = table_mark };

static JSValue make_export_function(JSContext *ctx, JSValueConst instance, IM3Function f, const char *name);

static JSValue table_length(JSContext *ctx, JSValueConst this_val) {
	WTable *t = JS_GetOpaque2(ctx, this_val, table_cid); if (!t) { return JS_EXCEPTION; }
	Instance *in = JS_GetOpaque(t->instance, instance_cid);
	return JS_NewUint32(ctx, in->mod->tables[t->index]->size);
}
static JSValue table_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	WTable *t = JS_GetOpaque2(ctx, this_val, table_cid); if (!t) { return JS_EXCEPTION; }
	Instance *in = JS_GetOpaque(t->instance, instance_cid);
	uint32_t i; if (JS_ToUint32(ctx, &i, argv[0])) { return JS_EXCEPTION; }
	IM3Table tab = in->mod->tables[t->index];
	if (i >= tab->size) { return JS_ThrowRangeError(ctx, "WebAssembly.Table.get(): invalid index"); }
	IM3Function f = tab->elements[i];
	return f ? make_export_function(ctx, t->instance, f, m3_GetFunctionName(f)) : JS_NULL;
}
static JSValue table_unsupported(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return JS_ThrowTypeError(ctx, "WebAssembly.Table.set/grow are not implemented in this host"); }

/* ---------- calling exported functions ---------- */
typedef union { int32_t i32; int64_t i64; float f32; double f64; } Val;

static JSValue call_export(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValueConst *data) {
	Instance *in = JS_GetOpaque(data[0], instance_cid);
	int64_t fp; JS_ToBigInt64(ctx, &fp, data[1]);
	IM3Function f = (IM3Function)(intptr_t)fp;
	uint32_t nargs = m3_GetArgCount(f), nrets = m3_GetRetCount(f);
	Val args[32]; const void *ptrs[32];
	if (nargs > 32) { return JS_ThrowTypeError(ctx, "too many arguments"); }
	for (uint32_t i = 0; i < nargs; i++) {
		JSValueConst a = i < (uint32_t)argc ? argv[i] : JS_UNDEFINED;
		switch (m3_GetArgType(f, i)) {
		case c_m3Type_i32: if (JS_ToInt32(ctx, &args[i].i32, a)) { return JS_EXCEPTION; } break;
		case c_m3Type_i64: { int64_t v; if (JS_ToBigInt64(ctx, &v, a)) { return JS_EXCEPTION; } args[i].i64 = v; break; }
		case c_m3Type_f32: { double d; if (JS_ToFloat64(ctx, &d, a)) { return JS_EXCEPTION; } args[i].f32 = (float)d; break; }
		case c_m3Type_f64: { double d; if (JS_ToFloat64(ctx, &d, a)) { return JS_EXCEPTION; } args[i].f64 = d; break; }
		default: return JS_ThrowTypeError(ctx, "unsupported argument type");
		}
		ptrs[i] = &args[i];
	}
	in->has_exc = 0;
	M3Result r = f->compiled ? NULL : CompileFunction(f);   /* wasm3 compiles lazily; m3_FindFunction normally does this, but we reach functions by index */
	if (!r) { r = m3_Call(f, nargs, ptrs); }
	if (r) {
		if (in->has_exc) { in->has_exc = 0; JSValue e = in->pending_exc; in->pending_exc = JS_UNDEFINED; return JS_Throw(ctx, e); }
		return throw_wasm_error(ctx, "RuntimeError", r);
	}
	if (nrets == 0) { return JS_UNDEFINED; }
	Val ret; const void *rptrs[1] = { &ret };
	r = m3_GetResults(f, 1, rptrs);
	if (r) { return throw_wasm_error(ctx, "RuntimeError", r); }
	switch (m3_GetRetType(f, 0)) {
	case c_m3Type_i32: return JS_NewInt32(ctx, ret.i32);
	case c_m3Type_i64: return JS_NewBigInt64(ctx, ret.i64);
	case c_m3Type_f32: return JS_NewFloat64(ctx, ret.f32);
	case c_m3Type_f64: return JS_NewFloat64(ctx, ret.f64);
	default: return JS_UNDEFINED;
	}
}

static JSValue make_export_function(JSContext *ctx, JSValueConst instance, IM3Function f, const char *name) {
	JSValue data[2] = { JS_DupValue(ctx, instance), JS_NewBigInt64(ctx, (int64_t)(intptr_t)f) };
	JSValue fn = JS_NewCFunctionData2(ctx, call_export, name ? name : "wasm_function", (int)m3_GetArgCount(f), 0, 2, data);
	JS_FreeValue(ctx, data[0]); JS_FreeValue(ctx, data[1]);
	return fn;
}

/* ---------- Instance ---------- */
static void instance_finalizer(JSRuntime *rt, JSValue v) {
	Instance *in = JS_GetOpaque(v, instance_cid); if (!in) { return; }
	for (int i = 0; i < in->n_import_fns; i++) { JS_FreeValueRT(rt, in->import_fns[i]); }
	free(in->import_fns);
	if (in->has_exc) { JS_FreeValueRT(rt, in->pending_exc); }
	if (in->rt) { m3_FreeRuntime(in->rt); }
	free(in->bytes); free(in);
}
static void instance_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark) {
	Instance *in = JS_GetOpaque(v, instance_cid); if (!in) { return; }
	for (int i = 0; i < in->n_import_fns; i++) { JS_MarkValue(rt, in->import_fns[i], mark); }
	if (in->has_exc) { JS_MarkValue(rt, in->pending_exc, mark); }
}
static JSClassDef instance_class = { "WebAssembly.Instance", .finalizer = instance_finalizer, .gc_mark = instance_mark };

static const char *kTrapJs = "JS exception in imported function";

/* One trampoline for every imported function: marshal wasm stack slots <-> JS values. Slots are 64-bit; returns come first, then args. */
static const void *import_trampoline(IM3Runtime rt, IM3ImportContext ictx, uint64_t *sp, void *mem) {
	ImportCtx *ic = ictx->userdata; Instance *in = ic->inst; JSContext *ctx = in->ctx;
	uint32_t nrets = ic->type->numRets, nargs = ic->type->numArgs;
	JSValue argv[16]; if (nargs > 16) { return "too many import arguments"; }
	for (uint32_t i = 0; i < nargs; i++) {
		uint64_t *slot = &sp[nrets + i];
		switch (ic->type->types[nrets + i]) {
		case c_m3Type_i32: argv[i] = JS_NewInt32(ctx, *(int32_t *)slot); break;
		case c_m3Type_i64: argv[i] = JS_NewBigInt64(ctx, *(int64_t *)slot); break;
		case c_m3Type_f32: argv[i] = JS_NewFloat64(ctx, *(float *)slot); break;
		case c_m3Type_f64: argv[i] = JS_NewFloat64(ctx, *(double *)slot); break;
		default: argv[i] = JS_UNDEFINED;
		}
	}
	JSValue r = JS_Call(ctx, ic->fn, JS_UNDEFINED, (int)nargs, argv);
	for (uint32_t i = 0; i < nargs; i++) { JS_FreeValue(ctx, argv[i]); }
	if (JS_IsException(r)) { in->pending_exc = JS_GetException(ctx); in->has_exc = 1; return kTrapJs; }
	if (nrets > 0) {
		switch (ic->type->types[0]) {
		case c_m3Type_i32: { int32_t v = 0; JS_ToInt32(ctx, &v, r); *(int32_t *)&sp[0] = v; break; }
		case c_m3Type_i64: { int64_t v = 0; JS_ToBigInt64(ctx, &v, r); *(int64_t *)&sp[0] = v; break; }
		case c_m3Type_f32: { double d = 0; JS_ToFloat64(ctx, &d, r); *(float *)&sp[0] = (float)d; break; }
		case c_m3Type_f64: { double d = 0; JS_ToFloat64(ctx, &d, r); *(double *)&sp[0] = d; break; }
		default: break;
		}
	}
	JS_FreeValue(ctx, r);
	return m3Err_none;
}

static char type_letter(m3type_t t) {
	switch (t) { case c_m3Type_i32: return 'i'; case c_m3Type_i64: return 'I'; case c_m3Type_f32: return 'f'; case c_m3Type_f64: return 'F'; case c_m3Type_none: return 'v'; default: return '?'; }
}

static JSValue instance_ctor(JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv) {
	WModule *wm = argc > 0 ? JS_GetOpaque(argv[0], module_cid) : NULL;
	if (!wm) { return JS_ThrowTypeError(ctx, "WebAssembly.Instance(): argument 0 must be a WebAssembly.Module"); }
	JSValueConst imports = argc > 1 ? argv[1] : JS_UNDEFINED;
	Instance *in = calloc(1, sizeof *in); in->ctx = ctx; in->pending_exc = JS_UNDEFINED;
	in->bytes = malloc(wm->len); memcpy(in->bytes, wm->bytes, wm->len);
	in->rt = m3_NewRuntime(g_env, 8 * 1024 * 1024, in);                    /* 8 MB wasm3 value stack: regex backtracking recurses */
	M3Result r = m3_ParseModule(g_env, &in->mod, in->bytes, (uint32_t)wm->len);
	if (!r) { r = m3_LoadModule(in->rt, in->mod); }
	if (r) { instance_finalizer(JS_GetRuntime(ctx), JS_UNDEFINED); free(in->bytes); free(in); return throw_wasm_error(ctx, "CompileError", r); }
	JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
	JSValue obj = JS_NewObjectProtoClass(ctx, proto, instance_cid); JS_FreeValue(ctx, proto);
	JS_SetOpaque(obj, in);
	/* link imported functions */
	in->import_fns = calloc(in->mod->numFuncImports + 1, sizeof(JSValue));
	for (uint32_t i = 0; i < in->mod->numFuncImports; i++) {
		IM3Function f = &in->mod->functions[i];
		const char *mn = f->import.moduleUtf8, *fnn = f->import.fieldUtf8;
		JSValue mo = JS_IsObject(imports) ? JS_GetPropertyStr(ctx, imports, mn) : JS_UNDEFINED;
		JSValue fn = JS_IsObject(mo) ? JS_GetPropertyStr(ctx, mo, fnn) : JS_UNDEFINED;
		JS_FreeValue(ctx, mo);
		if (!JS_IsFunction(ctx, fn)) { char msg[256]; snprintf(msg, sizeof msg, "WebAssembly.Instance(): import %s.%s must be a function", mn, fnn); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, obj); return throw_wasm_error(ctx, "LinkError", msg); }
		in->import_fns[in->n_import_fns++] = fn;
		ImportCtx *ic = malloc(sizeof *ic); ic->inst = in; ic->fn = fn; ic->type = f->funcType;     /* leaked with the instance: fine for a spike */
		char sig[40]; int p = 0; sig[p++] = f->funcType->numRets ? type_letter(f->funcType->types[0]) : 'v'; sig[p++] = '(';
		for (uint32_t a = 0; a < f->funcType->numArgs; a++) { sig[p++] = type_letter(f->funcType->types[f->funcType->numRets + a]); } sig[p++] = ')'; sig[p] = 0;
		r = m3_LinkRawFunctionEx(in->mod, mn, fnn, sig, import_trampoline, ic);
		if (r) { char msg[256]; snprintf(msg, sizeof msg, "WebAssembly.Instance(): cannot link %s.%s (%s)", mn, fnn, r); JS_FreeValue(ctx, obj); return throw_wasm_error(ctx, "LinkError", msg); }
	}
	/* exports */
	JSValue exports = JS_NewObjectProto(ctx, JS_NULL);
	for (uint32_t i = 0; i < in->mod->numExports; i++) {
		M3Export *e = &in->mod->exports[i];
		JSValue v = JS_UNDEFINED;
		switch (e->kind) {
		case d_externalKind_function: v = make_export_function(ctx, obj, &in->mod->functions[e->index], e->name); break;
		case d_externalKind_memory: { WMemory *m = calloc(1, sizeof *m); m->instance = JS_DupValue(ctx, obj); m->index = e->index; m->buffer = JS_UNDEFINED; v = JS_NewObjectClass(ctx, memory_cid); JS_SetOpaque(v, m); break; }
		case d_externalKind_table: { WTable *t = calloc(1, sizeof *t); t->instance = JS_DupValue(ctx, obj); t->index = e->index; v = JS_NewObjectClass(ctx, table_cid); JS_SetOpaque(v, t); break; }
		default: continue;
		}
		JS_DefinePropertyValueStr(ctx, exports, e->name, v, JS_PROP_ENUMERABLE);
	}
	JS_DefinePropertyValueStr(ctx, obj, "exports", exports, JS_PROP_ENUMERABLE);
	return obj;
}

/* ---------- registration ---------- */
static const char *prelude =
	"(function(WA){\n"
	"for (const n of ['CompileError','LinkError','RuntimeError']) { WA[n] = { [n]: class extends Error { constructor(m){ super(m); this.name = n; } } }[n]; }\n"
	"WA.validate = (b) => { try { new WA.Module(b); return true; } catch { return false; } };\n"
	"WA.compile = (b) => new Promise((res, rej) => { try { res(new WA.Module(b)); } catch (e) { rej(e); } });\n"
	"WA.instantiate = (src, imports) => new Promise((res, rej) => { try {\n"
	"  if (src instanceof WA.Module) { res(new WA.Instance(src, imports)); } else { const module = new WA.Module(src); res({ module, instance: new WA.Instance(module, imports) }); } } catch (e) { rej(e); } });\n"
	"})";

static const JSCFunctionListEntry memory_funcs[] = {
	JS_CGETSET_DEF("buffer", memory_buffer, NULL),
	JS_CFUNC_DEF("grow", 1, memory_grow),
};
static const JSCFunctionListEntry table_funcs[] = {
	JS_CGETSET_DEF("length", table_length, NULL),
	JS_CFUNC_DEF("get", 1, table_get), JS_CFUNC_DEF("set", 2, table_unsupported), JS_CFUNC_DEF("grow", 1, table_unsupported),
};

void spike_init_webassembly(JSContext *ctx) {
	JSRuntime *rt = JS_GetRuntime(ctx);
	if (!g_env) { g_env = m3_NewEnvironment(); }
	JS_NewClassID(rt, &module_cid); JS_NewClassID(rt, &instance_cid); JS_NewClassID(rt, &memory_cid); JS_NewClassID(rt, &table_cid);
	JS_NewClass(rt, module_cid, &module_class); JS_NewClass(rt, instance_cid, &instance_class); JS_NewClass(rt, memory_cid, &memory_class); JS_NewClass(rt, table_cid, &table_class);
	JSValue wa = JS_NewObject(ctx);
	JSValue mod_ctor = JS_NewCFunction2(ctx, (JSCFunction *)module_ctor, "Module", 1, JS_CFUNC_constructor, 0);
	JSValue mod_proto = JS_NewObject(ctx); JS_SetConstructor(ctx, mod_ctor, mod_proto); JS_FreeValue(ctx, mod_proto);
	JS_SetPropertyStr(ctx, wa, "Module", mod_ctor);
	JSValue inst_ctor = JS_NewCFunction2(ctx, (JSCFunction *)instance_ctor, "Instance", 2, JS_CFUNC_constructor, 0);
	JSValue inst_proto = JS_NewObject(ctx); JS_SetConstructor(ctx, inst_ctor, inst_proto); JS_FreeValue(ctx, inst_proto);
	JS_SetPropertyStr(ctx, wa, "Instance", inst_ctor);
	JSValue mem_proto = JS_NewObject(ctx); JS_SetPropertyFunctionList(ctx, mem_proto, memory_funcs, sizeof memory_funcs / sizeof *memory_funcs); JS_SetClassProto(ctx, memory_cid, mem_proto);
	JSValue tab_proto = JS_NewObject(ctx); JS_SetPropertyFunctionList(ctx, tab_proto, table_funcs, sizeof table_funcs / sizeof *table_funcs); JS_SetClassProto(ctx, table_cid, tab_proto);
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "WebAssembly", JS_DupValue(ctx, wa));
	JSValue init = JS_Eval(ctx, prelude, strlen(prelude), "<webassembly-prelude>", JS_EVAL_TYPE_GLOBAL);
	JSValue r = JS_Call(ctx, init, JS_UNDEFINED, 1, (JSValueConst[]){ wa });
	JS_FreeValue(ctx, r); JS_FreeValue(ctx, init); JS_FreeValue(ctx, wa); JS_FreeValue(ctx, g);
}
