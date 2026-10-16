/* timeline98.h - a per-process timeline of the event loop for launch analysis, included by the patched quickjs-libc.c of both hosts (07-native-render/host/build.sh,
 * 11-windows-host/host/patch_libc.py).
 *
 * Wall time is cut into 100 ms buckets; the loop's waits (poll / WaitForMultipleObjects / Sleep) and the blocking waits of synchronous calls (spawnSync,
 * reported by proc.c / winproc.c through js98_tl_sync) are added to them, and the rest of each bucket is time spent running JavaScript (or C called from it).
 * Off unless QJS98_TIMELINE names a directory (children inherit it) or JavaScript calls __timelineStart(dir); then every ~2 s, at a point where the loop is about to
 * wait, the process writes <dir>/<pid>.json: { pid, t0 (epoch ms of bucket 0), bucketMs, wait: [...], sync: [...], info } where info is whatever the JavaScript
 * function __timelineInfo() returns (a label and VS Code's performance marks), so the harness can merge all processes into one launch timeline. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <process.h>
#else
#include <time.h>
#include <unistd.h>
#endif

#define TL_BUCKET_MS 100
#define TL_N 9000   /* 15 minutes */
static uint16_t tl_wait[TL_N], tl_sync[TL_N];
static int tl_on = -1; static char tl_path[1024]; static uint64_t tl_t0_ns, tl_last_dump; static double tl_t0_epoch;

static double tl_epoch_ms(void) {
#ifdef _WIN32
	FILETIME ft; GetSystemTimeAsFileTime(&ft); uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime; return (double)(t / 10000) - 11644473600000.0;
#else
	struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
#endif
}
static void tl_start(const char *dir) {
	if (!dir || !*dir) { tl_on = 0; return; }
#ifdef _WIN32
	snprintf(tl_path, sizeof tl_path, "%s\\%lu.json", dir, (unsigned long)GetCurrentProcessId());
#else
	snprintf(tl_path, sizeof tl_path, "%s/%d.json", dir, (int)getpid());
#endif
	tl_t0_ns = js__hrtime_ns(); tl_t0_epoch = tl_epoch_ms(); tl_last_dump = tl_t0_ns; tl_on = 1;
}
static void tl_init(void) { if (tl_on < 0) { tl_start(getenv("QJS98_TIMELINE")); } }
/* adds the interval [a, b) (hrtime ns) to the buckets of arr */
static void tl_add(uint16_t *arr, uint64_t a, uint64_t b) {
	if (tl_on <= 0 || b <= a || a < tl_t0_ns) { return; }
	uint64_t bucket_ns = (uint64_t)TL_BUCKET_MS * 1000000u;
	while (a < b) {
		uint64_t k = (a - tl_t0_ns) / bucket_ns; if (k >= TL_N) { return; }
		uint64_t end = tl_t0_ns + (k + 1) * bucket_ns; uint64_t e = b < end ? b : end;
		uint32_t ms = (uint32_t)((e - a + 500000) / 1000000); uint32_t v = arr[k] + ms; arr[k] = (uint16_t)(v > TL_BUCKET_MS ? TL_BUCKET_MS : v); a = e;
	}
}
uint64_t js98_tl_now(void) { return js__hrtime_ns(); }   /* the clock of js98_tl_sync, for proc.c / winproc.c */
void js98_tl_sync(uint64_t a, uint64_t b) { tl_init(); tl_add(tl_sync, a, b); }
static void tl_put_arr(FILE *f, const char *name, const uint16_t *arr, int n) { fprintf(f, "\"%s\":[", name); for (int i = 0; i < n; i++) { fprintf(f, i ? ",%u" : "%u", arr[i]); } fputs("]", f); }
/* the sampling profiler (prof98.h, in quickjs.c) */
void js98_pf_tick(void); void js98_pf_dump(const char *timeline_path, int force); int js98_pf_tag_push(const char *label); void js98_pf_tag_pop(int pushed);
static void tl_dump(JSContext *ctx, int force) {
	uint64_t now = js__hrtime_ns(); tl_last_dump = now;
	int n = (int)((now - tl_t0_ns) / ((uint64_t)TL_BUCKET_MS * 1000000u)) + 1; if (n > TL_N) { n = TL_N; }
	char tmp[1100]; snprintf(tmp, sizeof tmp, "%s.tmp", tl_path);
	FILE *f = fopen(tmp, "wb"); if (!f) { return; }
#ifdef _WIN32
	fprintf(f, "{\"pid\":%lu,\"t0\":%.1f,\"bucketMs\":%d,", (unsigned long)GetCurrentProcessId(), tl_t0_epoch, TL_BUCKET_MS);
#else
	fprintf(f, "{\"pid\":%d,\"t0\":%.1f,\"bucketMs\":%d,", (int)getpid(), tl_t0_epoch, TL_BUCKET_MS);
#endif
	tl_put_arr(f, "wait", tl_wait, n); fputc(',', f); tl_put_arr(f, "sync", tl_sync, n);
	fputs(",\"info\":", f);
	int wrote = 0; JSValue g = JS_GetGlobalObject(ctx); JSValue fn = JS_GetPropertyStr(ctx, g, "__timelineInfo");
	if (JS_IsFunction(ctx, fn)) {
		JSValue r = JS_Call(ctx, fn, g, 0, NULL);
		if (JS_IsException(r)) { JS_FreeValue(ctx, JS_GetException(ctx)); }
		else if (JS_IsString(r)) { size_t len; const char *s = JS_ToCStringLen(ctx, &len, r); if (s) { fwrite(s, 1, len, f); wrote = 1; JS_FreeCString(ctx, s); } }
		JS_FreeValue(ctx, r);
	}
	JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
	if (!wrote) { fputs("null", f); }
	fputs("}\n", f); fclose(f);
	js98_pf_dump(tl_path, force);
#ifdef _WIN32
	MoveFileExA(tmp, tl_path, MOVEFILE_REPLACE_EXISTING);
#else
	rename(tmp, tl_path);
#endif
}
/* called where the loop is about to wait: writes the file every ~2 s; the profiler names its samples and labels the wait "[idle]" */
static int tl_pf_idle;
static void tl_tick(JSContext *ctx) { tl_init(); if (tl_on > 0 && js__hrtime_ns() - tl_last_dump >= 2000000000u) { tl_dump(ctx, 0); } js98_pf_tick(); tl_pf_idle = js98_pf_tag_push("[idle]"); }
static void tl_wait_done(uint64_t a) { js98_pf_tag_pop(tl_pf_idle); tl_pf_idle = 0; tl_add(tl_wait, a, js__hrtime_ns()); }
/* __timelineStart(dir): start recording in this process (the harness, which cannot have set its own environment before it started); __timelineDump(): write now */
static JSValue js98_tl_start_js(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { const char *d = JS_ToCString(ctx, argv[0]); if (d) { if (tl_on <= 0) { tl_start(d); } JS_FreeCString(ctx, d); } return JS_UNDEFINED; }
static JSValue js98_tl_dump_js(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { tl_init(); if (tl_on > 0) { tl_dump(ctx, 1); } return JS_NewBool(ctx, tl_on > 0); }
void js98_tl_install(JSContext *ctx) {
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__timelineStart", JS_NewCFunction(ctx, js98_tl_start_js, "__timelineStart", 1));
	JS_SetPropertyStr(ctx, g, "__timelineDump", JS_NewCFunction(ctx, js98_tl_dump_js, "__timelineDump", 0));
	JS_FreeValue(ctx, g);
}
