/* Native ES-module integration for the Node-compat layer: what QuickJS's stock loader cannot do from JS.
 *  1. Module specifier resolution is delegated to JS (`globalThis.__esmResolve(specifier, importerName)`), so Node's algorithm (bare specifiers via node_modules and
 *     package.json "exports"/"main", `node:` builtins -> shims, file: URLs, registered `module.registerHooks({ resolve })` hooks) runs for static AND dynamic imports.
 *  2. Module loading is delegated to JS first (`globalThis.__esmLoad(name)`), which can answer with ES source (data: URLs from resolve hooks), or a CommonJS module
 *     (`import x from './a.cjs'`, `import fs from 'pkg-with-cjs-main'`) that is wrapped in a synthetic ES module; `undefined` falls through to the stock file loader.
 *  3. `requireEsm(path)`: synchronous require() of an ES module (Node 24's require(esm)): QuickJS loads module graphs synchronously, only top-level await is refused. */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include "quickjs.h"
#include "quickjs-libc.h"

/* ---- bytecode cache for large ES modules (the 42.7 MB workbench bundle took 4.4 to 4.9 s to compile on the sandbox; its bytecode reads back in ~0.2 s).
 * Directory: QJS98_CODE_CACHE, or __codeCacheDir(dir) from JavaScript. A file per module source: <dir>/<hash of the source>.qbc, starting with a header that names this
 * build (another executable never reads the file) and the module name it was compiled under. The name is part of the bytecode (it resolves the module's relative imports
 * and names it in stack traces), so when the module is now loaded under another name (another install folder: the package ships a cache made under Wine), that one
 * string of the bytecode's atom table is replaced before reading (bc_rename). The source text is not stored (JS_WRITE_OBJ_STRIP_SOURCE: line numbers stay, so stack
 * traces keep working; Function.prototype.toString of these functions shows no source). Anything unexpected falls back to compiling. */
static char cache_dir[1024]; static int cache_state = -1;   /* -1 not looked up, 0 off, 1 on */
static const char CACHE_MAGIC[] = "QJ98BC2 " __DATE__ " " __TIME__;
static long cache_hits, cache_renamed, cache_writes;
static int cache_on(void) { if (cache_state < 0) { const char *d = getenv("QJS98_CODE_CACHE"); cache_state = d && *d && strlen(d) < sizeof cache_dir - 40; if (cache_state) { strcpy(cache_dir, d); } } return cache_state; }
static uint64_t fnv64(uint64_t h, const char *s, size_t n) { for (size_t i = 0; i < n; i++) { h = (h ^ (uint8_t)s[i]) * 1099511628211ull; } return h; }
static void cache_path(char *out, size_t cap, uint64_t key) { snprintf(out, cap, "%s/%016llx.qbc", cache_dir, (unsigned long long)key); }
static int leb_get(const uint8_t *p, const uint8_t *end, uint32_t *v) { uint32_t r = 0; for (int i = 0; i < 5 && p + i < end; i++) { r |= (uint32_t)(p[i] & 0x7f) << (7 * i); if (!(p[i] & 0x80)) { *v = r; return i + 1; } } return 0; }
static int leb_put(uint8_t *o, uint32_t v) { int n = 0; do { uint8_t b = v & 0x7f; v >>= 7; o[n++] = b | (v ? 0x80 : 0); } while (v); return n; }
/* a UTF-8 string as QuickJS writes a JSString into bytecode (JS_WriteString): leb128(len << 1 | wide), then 8-bit or UTF-16 units */
static uint8_t *bc_string(const char *u, size_t *outlen) {
	size_t n = strlen(u); uint32_t *cp = malloc((n + 1) * sizeof(uint32_t)); size_t k = 0; int wide = 0;
	for (size_t i = 0; i < n;) {
		uint8_t c = (uint8_t)u[i]; uint32_t x; int l = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
		if (i + l > n) { free(cp); return NULL; } x = l == 1 ? c : l == 2 ? c & 0x1f : l == 3 ? c & 0x0f : c & 0x07; for (int j = 1; j < l; j++) { x = (x << 6) | ((uint8_t)u[i + j] & 0x3f); }
		if (x > 0xFFFF) { wide = 1; x -= 0x10000; cp[k++] = 0xD800 + (x >> 10); cp[k++] = 0xDC00 + (x & 0x3ff); cp = realloc(cp, (n + k + 2) * sizeof(uint32_t)); } else { if (x > 0xFF) { wide = 1; } cp[k++] = x; }
		i += (size_t)l;
	}
	uint8_t *o = malloc(5 + k * 2); int h = leb_put(o, (uint32_t)(k << 1) | (uint32_t)wide); size_t m = (size_t)h;
	for (size_t i = 0; i < k; i++) { if (wide) { o[m++] = (uint8_t)(cp[i] & 0xff); o[m++] = (uint8_t)(cp[i] >> 8); } else { o[m++] = (uint8_t)cp[i]; } }
	free(cp); *outlen = m; return o;
}
/* the bytecode with the atom `from` replaced by `to` (a new buffer, checksum marked "not checked"), or NULL */
static uint8_t *bc_rename(const uint8_t *bc, size_t len, const char *from, const char *to, size_t *outlen) {
	if (len < 6) { return NULL; }
	size_t fl, tl; uint8_t *f = bc_string(from, &fl), *t = bc_string(to, &tl); if (!f || !t) { free(f); free(t); return NULL; }
	const uint8_t *p = bc + 5, *end = bc + len; uint32_t count; int k = leb_get(p, end, &count); uint8_t *out = NULL;
	if (k) {
		p += k;
		for (uint32_t i = 0; i < count && p < end; i++) {
			uint8_t type = *p++;
			if (type & 0x80) { if ((type & 0xC0) == 0xC0) { uint32_t v; int m = leb_get(p, end, &v); if (!m) { break; } p += m; } continue; }
			uint32_t hdr; int m = leb_get(p, end, &hdr); if (!m) { break; } size_t sz = (size_t)m + (hdr >> 1) * ((hdr & 1) ? 2 : 1); if (p + sz > end) { break; }
			if (sz == fl && memcmp(p, f, fl) == 0) {
				size_t pre = (size_t)(p - bc), post = len - pre - sz; out = malloc(pre + tl + post);
				memcpy(out, bc, pre); memcpy(out + pre, t, tl); memcpy(out + pre + tl, p + sz, post); memset(out + 1, 0xFF, 4); *outlen = pre + tl + post; break;
			}
			p += sz;
		}
	}
	free(f); free(t); return out;
}
static JSValue cache_read(JSContext *ctx, uint64_t key, const char *name) {
	char path[1100]; cache_path(path, sizeof path, key); FILE *f = fopen(path, "rb"); if (!f) { return JS_UNDEFINED; }
	fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); size_t hl = sizeof CACHE_MAGIC + sizeof key + 4;
	if (n <= (long)hl) { fclose(f); return JS_UNDEFINED; }
	uint8_t *buf = malloc((size_t)n); size_t got = fread(buf, 1, (size_t)n, f); fclose(f);
	JSValue r = JS_UNDEFINED; uint32_t nl = 0;
	if (got == (size_t)n && memcmp(buf, CACHE_MAGIC, sizeof CACHE_MAGIC) == 0 && memcmp(buf + sizeof CACHE_MAGIC, &key, sizeof key) == 0) {
		memcpy(&nl, buf + sizeof CACHE_MAGIC + sizeof key, 4);
		if (hl + nl < (size_t)n) {
			char *old = malloc(nl + 1); memcpy(old, buf + hl, nl); old[nl] = 0; const uint8_t *bc = buf + hl + nl; size_t bl = (size_t)n - hl - nl;
			if (strcmp(old, name) == 0) { r = JS_ReadObject(ctx, bc, bl, JS_READ_OBJ_BYTECODE); }
			else { size_t rl; uint8_t *rb = bc_rename(bc, bl, old, name, &rl); if (rb) { r = JS_ReadObject(ctx, rb, rl, JS_READ_OBJ_BYTECODE); free(rb); if (!JS_IsException(r)) { cache_renamed++; } } }
			if (JS_IsException(r)) { JS_FreeValue(ctx, JS_GetException(ctx)); r = JS_UNDEFINED; }
			free(old);
		}
	}
	free(buf); return r;
}
static void cache_write(JSContext *ctx, uint64_t key, const char *name, JSValueConst fn) {
	size_t len; uint8_t *bc = JS_WriteObject(ctx, &len, fn, JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_STRIP_SOURCE); if (!bc) { JS_FreeValue(ctx, JS_GetException(ctx)); return; }
	char path[1100], tmp[1120]; cache_path(path, sizeof path, key); snprintf(tmp, sizeof tmp, "%s.tmp", path);
	FILE *f = fopen(tmp, "wb"); uint32_t nl = (uint32_t)strlen(name);
	if (f) {
		int ok = fwrite(CACHE_MAGIC, 1, sizeof CACHE_MAGIC, f) == sizeof CACHE_MAGIC && fwrite(&key, 1, sizeof key, f) == sizeof key && fwrite(&nl, 1, 4, f) == 4 && fwrite(name, 1, nl, f) == nl && fwrite(bc, 1, len, f) == len; ok = fclose(f) == 0 && ok;
		if (ok) { remove(path); ok = rename(tmp, path) == 0; } if (!ok) { remove(tmp); } else { cache_writes++; }
	}
	js_free(ctx, bc);
}
/* compiles module source, through the cache when the module is large */
static JSValue compile_module(JSContext *ctx, const char *s, size_t len, const char *name) {
	if (len < 128 * 1024 || !cache_on()) { return JS_Eval(ctx, s, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY); }
	uint64_t key = fnv64(1469598103934665603ull ^ (uint64_t)len, s, len);
	JSValue fn = cache_read(ctx, key, name); if (!JS_IsUndefined(fn)) { cache_hits++; return fn; }
	fn = JS_Eval(ctx, s, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
	if (!JS_IsException(fn)) { cache_write(ctx, key, name, fn); }
	return fn;
}
static JSValue js_code_cache_dir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {   /* __codeCacheDir(dir) -> previous setting; __codeCacheDir() -> { dir, hits, writes } */
	if (argc > 0 && JS_IsString(argv[0])) { const char *d = JS_ToCString(ctx, argv[0]); if (d && strlen(d) < sizeof cache_dir - 40) { strcpy(cache_dir, d); cache_state = *d != 0; } JS_FreeCString(ctx, d); }
	JSValue o = JS_NewObject(ctx); JS_SetPropertyStr(ctx, o, "dir", cache_on() ? JS_NewString(ctx, cache_dir) : JS_NULL); JS_SetPropertyStr(ctx, o, "hits", JS_NewInt64(ctx, cache_hits)); JS_SetPropertyStr(ctx, o, "renamed", JS_NewInt64(ctx, cache_renamed)); JS_SetPropertyStr(ctx, o, "writes", JS_NewInt64(ctx, cache_writes)); return o;
}
void spike_install_code_cache(JSContext *ctx) { JSValue g = JS_GetGlobalObject(ctx); JS_SetPropertyStr(ctx, g, "__codeCacheDir", JS_NewCFunction(ctx, js_code_cache_dir, "__codeCacheDir", 1)); JS_FreeValue(ctx, g); }

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
					JSValue fn = compile_module(ctx, s, len, name);
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
	spike_install_code_cache(ctx);
}
