/* Spike 1a: can QuickJS-ng parse and compile a big ES-module bundle, how fast, and with how much memory?
 * Compiles each file given on the command line as an ES module WITHOUT running it (JS_EVAL_FLAG_COMPILE_ONLY), then
 * serializes the result to bytecode and reloads it, to measure what precompiling could save at startup.
 * Build:  gcc -O2 -o parse_bench parse_bench.c -I$QJS -L$QJS/build -lqjs -lm -lpthread   ($QJS = quickjs-ng checkout, built with cmake)
 * Usage:  parse_bench [--strict-script] file.js...   (prints one line per file; failures print the exception)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>
#include "quickjs.h"

static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static long peak_rss_kb(void) { struct rusage r; getrusage(RUSAGE_SELF, &r); return r.ru_maxrss; }

static uint8_t *read_file(const char *path, size_t *len) {
	FILE *f = fopen(path, "rb"); if (!f) return NULL;
	fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
	uint8_t *buf = malloc(n + 1); if (fread(buf, 1, n, f) != (size_t)n) { fclose(f); free(buf); return NULL; }
	buf[n] = 0; fclose(f); *len = n; return buf;
}

/* Module loader for the benchmark: bare specifiers (fs, node:path, electron, ...) become empty stub modules (we only want to know whether the
 * code PARSES; named-import checks happen at link time, which COMPILE_ONLY skips); relative specifiers are read from disk and compiled. */
static int stub_init(JSContext *ctx, JSModuleDef *m) { return 0; }
static JSModuleDef *bench_loader(JSContext *ctx, const char *name, void *opaque) {
	if (name[0] != '.' && name[0] != '/') { return JS_NewCModule(ctx, name, stub_init); }
	size_t len; uint8_t *src = read_file(name, &len);
	if (!src) { JS_ThrowReferenceError(ctx, "cannot read module '%s'", name); return NULL; }
	JSValue fn = JS_Eval(ctx, (const char *)src, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
	free(src);
	if (JS_IsException(fn)) { return NULL; }
	JSModuleDef *m = JS_VALUE_GET_PTR(fn); JS_FreeValue(ctx, fn); return m;
}

int main(int argc, char **argv) {
	int module = 1, ai = 1;
	if (argc > 1 && !strcmp(argv[1], "--script")) { module = 0; ai = 2; }
	for (; ai < argc; ai++) {
		size_t len; uint8_t *src = read_file(argv[ai], &len);
		if (!src) { printf("%s: cannot read\n", argv[ai]); continue; }
		long rss0 = peak_rss_kb();
		JSRuntime *rt = JS_NewRuntime(); JSContext *ctx = JS_NewContext(rt);
		JS_SetMaxStackSize(rt, 0); JS_SetModuleLoaderFunc(rt, NULL, bench_loader, NULL);
		double t0 = now_ms();
		JSValue fn = JS_Eval(ctx, (const char *)src, len, argv[ai], (module ? JS_EVAL_TYPE_MODULE : 0) | JS_EVAL_FLAG_COMPILE_ONLY);
		double t1 = now_ms();
		if (JS_IsException(fn)) {
			JSValue ex = JS_GetException(ctx); const char *s = JS_ToCString(ctx, ex);
			printf("%-60s FAILED after %.0f ms: %.300s\n", argv[ai], t1 - t0, s ? s : "?"); if (s) JS_FreeCString(ctx, s); JS_FreeValue(ctx, ex);
		} else {
			JSMemoryUsage mu; JS_ComputeMemoryUsage(rt, &mu);
			size_t blen; uint8_t *bc = JS_WriteObject(ctx, &blen, fn, JS_WRITE_OBJ_BYTECODE);
			double t2 = now_ms(); double reload = -1;
			if (bc) {
				JSValue back = JS_ReadObject(ctx, bc, blen, JS_READ_OBJ_BYTECODE); reload = now_ms() - t2;
				if (!JS_IsException(back)) { JS_FreeValue(ctx, back); } else { reload = -2; }
			}
			printf("%-60s src %6.1f MB  compile %7.0f ms (%.1f MB/s)  heap %6.1f MB  funcs %7ld  bytecode %6.1f MB  reload-from-bytecode %6.0f ms  peakRSS %5.0f MB\n",
				argv[ai], len / 1048576.0, t1 - t0, len / 1048576.0 / ((t1 - t0) / 1000), mu.malloc_size / 1048576.0, (long)mu.js_func_count,
				bc ? blen / 1048576.0 : -1.0, reload, (peak_rss_kb() - rss0 + rss0) / 1024.0);
			if (bc) js_free(ctx, bc);
			JS_FreeValue(ctx, fn);
		}
		JS_FreeContext(ctx); JS_FreeRuntime(rt); free(src);
	}
	return 0;
}
