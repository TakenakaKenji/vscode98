/* Native ES-module integration for the Node-compat layer: what QuickJS's stock loader cannot do from JS.
 *  1. Module specifier resolution is delegated to JS (`globalThis.__esmResolve(specifier, importerName)`), so Node's algorithm (bare specifiers via node_modules and
 *     package.json "exports"/"main", `node:` builtins -> shims, file: URLs, registered `module.registerHooks({ resolve })` hooks) runs for static AND dynamic imports.
 *  2. Module loading is delegated to JS first (`globalThis.__esmLoad(name)`), which can answer with ES source (data: URLs from resolve hooks), or a CommonJS module
 *     (`import x from './a.cjs'`, `import fs from 'pkg-with-cjs-main'`) that is wrapped in a synthetic ES module; `undefined` falls through to the stock file loader.
 *  3. `requireEsm(path)`: synchronous require() of an ES module (Node 24's require(esm)): QuickJS loads module graphs synchronously, only top-level await is refused. */
#include <string.h>
#include "quickjs.h"
#include "quickjs-libc.h"

static JSValue get_hook(JSContext *ctx, const char *name) {
	JSValue g = JS_GetGlobalObject(ctx), f = JS_GetPropertyStr(ctx, g, name); JS_FreeValue(ctx, g); return f;
}

/* stock behaviour (relative specifiers only) for scripts that run before the JS resolver is installed */
static char *simple_normalize(JSContext *ctx, const char *base, const char *name) {
	if (name[0] != '.') { return js_strdup(ctx, name); }
	size_t bl = strlen(base), nl = strlen(name); char *buf = js_malloc(ctx, bl + nl + 2); if (!buf) { return NULL; }
	size_t slash = bl; while (slash > 0 && base[slash - 1] != '/') { slash--; }
	memcpy(buf, base, slash); buf[slash] = 0; strcat(buf, name);
	char *r = buf, *w = buf; /* collapse "./" and "x/../" */
	char *out = js_malloc(ctx, strlen(buf) + 1); w = out; const char *p = buf;
	while (*p) {
		if (p[0] == '.' && p[1] == '/' && (p == buf || p[-1] == '/')) { p += 2; continue; }
		if (p[0] == '.' && p[1] == '.' && p[2] == '/' && (p == buf || p[-1] == '/') && w > out + 1 && w[-1] == '/') { char *q = w - 1; while (q > out && q[-1] != '/') { q--; } if (!(q[0] == '.' && q[1] == '.' && q[2] == '/')) { w = q; p += 3; continue; } }
		*w++ = *p++;
	}
	*w = 0; js_free(ctx, r); return out;
}
static char *esm_normalize(JSContext *ctx, const char *base, const char *name, void *opaque) {
	JSValue f = get_hook(ctx, "__esmResolve");
	if (!JS_IsFunction(ctx, f)) { JS_FreeValue(ctx, f); return simple_normalize(ctx, base ? base : "", name); }
	JSValue args[2] = { JS_NewString(ctx, name), JS_NewString(ctx, base ? base : "") };
	JSValue r = JS_Call(ctx, f, JS_UNDEFINED, 2, args);
	JS_FreeValue(ctx, args[0]); JS_FreeValue(ctx, args[1]); JS_FreeValue(ctx, f);
	if (JS_IsException(r)) { return NULL; }
	const char *s = JS_ToCString(ctx, r); JS_FreeValue(ctx, r); if (!s) { return NULL; }
	char *out = js_strdup(ctx, s); JS_FreeCString(ctx, s); return out;
}

/* synthetic ES module around a CommonJS exports object: `default` = module.exports plus one named export per own enumerable key (a superset of what Node's lexer finds) */
static int cjs_init(JSContext *ctx, JSModuleDef *m) {
	JSValue ex = JS_GetModulePrivateValue(ctx, m);
	JS_SetModuleExport(ctx, m, "default", JS_DupValue(ctx, ex));
	JSPropertyEnum *tab; uint32_t n;
	if (JS_IsObject(ex) || JS_IsFunction(ctx, ex)) {
		if (JS_GetOwnPropertyNames(ctx, &tab, &n, ex, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
			for (uint32_t i = 0; i < n; i++) {
				const char *k = JS_AtomToCString(ctx, tab[i].atom);
				if (k && strcmp(k, "default") != 0) { JSValue v = JS_GetProperty(ctx, ex, tab[i].atom); JS_SetModuleExport(ctx, m, k, v); }
				JS_FreeCString(ctx, k); JS_FreeAtom(ctx, tab[i].atom);
			}
			js_free(ctx, tab);
		}
	}
	JS_FreeValue(ctx, ex);
	return 0;
}

static JSModuleDef *esm_loader(JSContext *ctx, const char *name, void *opaque, JSValueConst attributes) {
	JSValue f = get_hook(ctx, "__esmLoad");
	if (JS_IsFunction(ctx, f)) {
		JSValue arg = JS_NewString(ctx, name), r = JS_Call(ctx, f, JS_UNDEFINED, 1, &arg);
		JS_FreeValue(ctx, arg); JS_FreeValue(ctx, f);
		if (JS_IsException(r)) { return NULL; }
		if (!JS_IsUndefined(r)) {
			JSValue fmt = JS_GetPropertyStr(ctx, r, "format"); const char *fs = JS_ToCString(ctx, fmt); JS_FreeValue(ctx, fmt);
			JSModuleDef *m = NULL;
			if (fs && strcmp(fs, "module") == 0) {
				JSValue src = JS_GetPropertyStr(ctx, r, "source"); size_t len; const char *s = JS_ToCStringLen(ctx, &len, src); JS_FreeValue(ctx, src);
				if (s) {
					JSValue fn = JS_Eval(ctx, s, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
					JS_FreeCString(ctx, s);
					if (!JS_IsException(fn)) {
						m = JS_VALUE_GET_PTR(fn);
						JSValue meta = JS_GetImportMeta(ctx, m);
						static const char *const keys[] = { "url", "filename", "dirname" };   /* import.meta.* as in Node 20.11+ */
						for (int i = 0; i < 3; i++) { JSValue v = JS_GetPropertyStr(ctx, r, keys[i]); if (!JS_IsUndefined(v)) { JS_SetPropertyStr(ctx, meta, keys[i], v); } else { JS_FreeValue(ctx, v); } }
						JS_FreeValue(ctx, meta); JS_FreeValue(ctx, fn);
					}
				}
			} else if (fs && strcmp(fs, "commonjs") == 0) {
				JSValue ex = JS_GetPropertyStr(ctx, r, "exports");
				m = JS_NewCModule(ctx, name, cjs_init);
				if (m) {
					JS_AddModuleExport(ctx, m, "default");
					JSPropertyEnum *tab; uint32_t n;
					if ((JS_IsObject(ex) || JS_IsFunction(ctx, ex)) && JS_GetOwnPropertyNames(ctx, &tab, &n, ex, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
						for (uint32_t i = 0; i < n; i++) { const char *k = JS_AtomToCString(ctx, tab[i].atom); if (k && strcmp(k, "default") != 0) { JS_AddModuleExport(ctx, m, k); } JS_FreeCString(ctx, k); JS_FreeAtom(ctx, tab[i].atom); }
						js_free(ctx, tab);
					}
					JS_SetModulePrivateValue(ctx, m, JS_DupValue(ctx, ex));
				}
				JS_FreeValue(ctx, ex);
			} else { JS_ThrowTypeError(ctx, "__esmLoad returned an unknown format"); }
			if (fs) { JS_FreeCString(ctx, fs); }
			JS_FreeValue(ctx, r);
			return m;
		}
		JS_FreeValue(ctx, r);
	} else { JS_FreeValue(ctx, f); }
	return js_module_loader(ctx, name, opaque, attributes);
}

void spike_install_loader(JSRuntime *rt) { JS_SetModuleLoaderFunc2(rt, esm_normalize, esm_loader, js_module_check_attributes, NULL); }

/* requireEsm(absolutePath) -> module namespace; throws if the graph uses top-level await (ERR_REQUIRE_ASYNC_MODULE).
 * Evaluates `import * as ns from "<path>"; globalThis.__esmNs = ns;` as a module: JS_EvalFunction runs a TLA-free graph to completion before it returns
 * (JS_LoadModule would answer through a promise reaction, i.e. one microtask too late for a synchronous require). */
static JSValue js_require_esm(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t plen; const char *path = JS_ToCStringLen(ctx, &plen, argv[0]); if (!path) { return JS_EXCEPTION; }
	char *src = js_malloc(ctx, plen * 2 + 64); if (!src) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	char *w = src; w += sprintf(w, "import * as ns from \"");
	for (size_t i = 0; i < plen; i++) { if (path[i] == '"' || path[i] == '\\') { *w++ = '\\'; } *w++ = path[i]; }
	w += sprintf(w, "\"; globalThis.__esmNs = ns;");
	JS_FreeCString(ctx, path);
	JSValue fn = JS_Eval(ctx, src, w - src, "<require>", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY); js_free(ctx, src);
	if (JS_IsException(fn)) { return fn; }
	JSValue p = JS_EvalFunction(ctx, fn);
	if (JS_IsException(p)) { return p; }
	JSValue res;
	switch (JS_PromiseState(ctx, p)) {
	case JS_PROMISE_FULFILLED: { JSValue g = JS_GetGlobalObject(ctx); res = JS_GetPropertyStr(ctx, g, "__esmNs"); JS_SetPropertyStr(ctx, g, "__esmNs", JS_UNDEFINED); JS_FreeValue(ctx, g); break; }
	case JS_PROMISE_REJECTED: res = JS_Throw(ctx, JS_PromiseResult(ctx, p)); break;
	default: { JS_ThrowTypeError(ctx, "require() cannot be used on an ESM graph with top-level await"); JSValue e = JS_GetException(ctx); JS_SetPropertyStr(ctx, e, "code", JS_NewString(ctx, "ERR_REQUIRE_ASYNC_MODULE")); res = JS_Throw(ctx, e); }
	}
	JS_FreeValue(ctx, p); return res;
}
void spike_init_esm(JSContext *ctx) {
	JSValue g = JS_GetGlobalObject(ctx); JS_SetPropertyStr(ctx, g, "__requireEsm", JS_NewCFunction(ctx, js_require_esm, "__requireEsm", 1)); JS_FreeValue(ctx, g);
}
