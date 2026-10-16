/* prof98.h - a sampling profiler of the JavaScript stack, for launch and interaction analysis. Included at the end of a patched copy of QuickJS-ng's quickjs.c
 * (patch_quickjs.py, used by 07-native-render/host/build.sh and 11-windows-host/host/build_win.sh), so it reads QuickJS's own call frames.
 *
 * Off unless QJS98_PROFILE is set (children inherit it) to the sampling interval in ms (1 to 100; anything else means 5). Every interval the profiler copies
 * the frame chain of the main runtime (rt->current_stack_frame) into a ring of raw samples: per frame the function's bytecode, or the C function and its
 * magic. No allocation, no locks and no JavaScript happen while it samples:
 *  - Windows: a sampler thread suspends the main thread (SuspendThread + GetThreadContext), copies the chain and resumes it; wall-clock samples, so the
 *    event-loop wait shows up as "[idle]".
 *  - Linux: a CPU-time timer of the main thread (timer_create(CLOCK_THREAD_CPUTIME_ID), SIGPROF to that thread); the handler copies the chain. CPU time only.
 * The main thread turns raw samples into function ids (names "func file:line:col", "[native] name") at safe points: each event-loop turn, when the ring is
 * half full (js_poll_interrupts), and before a function's bytecode is freed (so a sampled pointer is resolved while it is still valid and a reused address
 * gets a new id). C function names are recorded when the functions are created. Labels for work without a frame of its own: "[gc]", "[compile]",
 * "[read bytecode]" (esm.c), "[idle]" (timeline98.h).
 * Output: with the timeline on, <dir>/<pid>.prof.json next to <pid>.json: { pid, t0 (epoch ms), intervalMs, clock, dropped, names: [...],
 * stacks: [[name ids, leaf first, -1 if cut at PF_DEPTH], ...], samples: [t ms, stack id, weight µs (the time the sample stands for), ...] }, merged by 10-main-shim/host/timeline_report98.js. */
#ifdef _WIN32
#include <windows.h>
#else
#include <signal.h>
#include <time.h>
#include <pthread.h>
#include <unistd.h>
#include <sys/syscall.h>
#endif

#define PF_DEPTH 64
#define PF_RING 2048
#define PF_MAXTAG 8
enum { PF_K_BC = 1, PF_K_CF, PF_K_TAG, PF_K_CLASS, PF_K_DEAD = 255 };
typedef struct { uint32_t t, w; uint16_t n; uint8_t cut; uint8_t kind[PF_DEPTH]; int32_t magic[PF_DEPTH]; const void *p[PF_DEPTH]; } PfRaw;
typedef struct { const char *label; JSStackFrame *sf; } PfTag;

static int pf_state = -1;   /* -1 not decided, 0 off, 1 on */
static int pf_interval = 5;
static JSRuntime *volatile pf_rt;
static PfRaw pf_ring[PF_RING];
static volatile uint32_t pf_head, pf_tail, pf_dropped;
static PfTag pf_tags[PF_MAXTAG];
static volatile int pf_ntag;
static uint64_t pf_t0_ns, pf_last_ns; static double pf_t0_epoch;
#ifdef _WIN32
static DWORD pf_tid; static HANDLE pf_thread, pf_main, pf_stop;
#else
static pthread_t pf_thread_self; static timer_t pf_timer; static int pf_timer_on;
#endif

static void pf_write(void);
static inline void pf_barrier(void) { __asm__ __volatile__("" ::: "memory"); }
static int pf_is_main(void) {
#ifdef _WIN32
	return GetCurrentThreadId() == pf_tid;
#else
	return pthread_equal(pthread_self(), pf_thread_self);
#endif
}
/* the clock a sample's weight is measured on: the main thread's CPU time on Linux (the timer fires on the kernel tick, not at the interval asked for),
 * wall time on Windows (the sampler's wait can be longer than the interval) */
static uint64_t pf_clock_ns(void);
static uint64_t pf_now_ns(void) {
#ifdef _WIN32
	static LARGE_INTEGER f; LARGE_INTEGER c; if (!f.QuadPart) { QueryPerformanceFrequency(&f); } QueryPerformanceCounter(&c);
	return (uint64_t)((double)c.QuadPart * 1e9 / (double)f.QuadPart);
#else
	struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000000000u + ts.tv_nsec;
#endif
}

static uint64_t pf_clock_ns(void) {
#ifdef _WIN32
	return pf_now_ns();
#else
	struct timespec ts; clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts); return (uint64_t)ts.tv_sec * 1000000000u + ts.tv_nsec;
#endif
}

/* ---- sampling: runs while the main thread is stopped (Windows) or interrupted (Linux signal handler) ---- */
static void pf_take(void) {
	JSRuntime *rt = pf_rt; if (!rt) { return; }
	uint32_t h = pf_head; if (h - pf_tail >= PF_RING) { pf_dropped++; return; }
	PfRaw *r = &pf_ring[h % PF_RING];
	r->t = (uint32_t)((pf_now_ns() - pf_t0_ns) / 1000000u);
	uint64_t c = pf_clock_ns(); r->w = (uint32_t)((c - pf_last_ns) / 1000u); pf_last_ns = c;
	int n = 0; JSStackFrame *sf = rt->current_stack_frame;
	int nt = pf_ntag; if (nt > 0 && nt <= PF_MAXTAG && pf_tags[nt - 1].sf == sf && pf_tags[nt - 1].label) { r->kind[n] = PF_K_TAG; r->p[n] = pf_tags[nt - 1].label; r->magic[n] = 0; n++; }
	for (; sf && n < PF_DEPTH; sf = sf->prev_frame) {
		JSValue v = sf->cur_func; r->magic[n] = 0;
		if (JS_VALUE_GET_TAG(v) != JS_TAG_OBJECT) { r->kind[n] = PF_K_CLASS; r->p[n] = NULL; r->magic[n] = -1; n++; continue; }
		JSObject *p = JS_VALUE_GET_OBJ(v);
		switch (p->class_id) {
		case JS_CLASS_BYTECODE_FUNCTION: case JS_CLASS_GENERATOR_FUNCTION: case JS_CLASS_ASYNC_FUNCTION: case JS_CLASS_ASYNC_GENERATOR_FUNCTION:
			r->kind[n] = PF_K_BC; r->p[n] = p->u.func.function_bytecode; break;
		case JS_CLASS_C_FUNCTION: r->kind[n] = PF_K_CF; r->p[n] = (const void *)p->u.cfunc.c_function.generic; r->magic[n] = p->u.cfunc.magic; break;
		case JS_CLASS_C_FUNCTION_DATA: r->kind[n] = PF_K_CF; r->p[n] = (const void *)p->u.c_function_data_record->func; r->magic[n] = p->u.c_function_data_record->magic; break;
		case JS_CLASS_C_CLOSURE: r->kind[n] = PF_K_CF; r->p[n] = (const void *)p->u.c_closure_record->func; r->magic[n] = p->u.c_closure_record->magic; break;
		default: r->kind[n] = PF_K_CLASS; r->p[n] = NULL; r->magic[n] = p->class_id; break;
		}
		n++;
	}
	if (n == 0) { r->kind[0] = PF_K_TAG; r->p[0] = "[host]"; r->magic[0] = 0; n = 1; }   /* C code of the host outside any JavaScript call (the event loop, module loading) */
	r->n = (uint16_t)n; r->cut = sf != NULL;
	pf_barrier(); pf_head = h + 1;
}
#ifdef _WIN32
static DWORD WINAPI pf_sampler(LPVOID arg) {
	(void)arg; CONTEXT c;
	while (WaitForSingleObject(pf_stop, (DWORD)pf_interval) == WAIT_TIMEOUT) {
		if (SuspendThread(pf_main) == (DWORD)-1) { break; }
		memset(&c, 0, sizeof c); c.ContextFlags = CONTEXT_CONTROL; GetThreadContext(pf_main, &c);   /* returns once the thread has really stopped */
		pf_take();
		ResumeThread(pf_main);
	}
	return 0;
}
#else
static void pf_signal(int sig) { (void)sig; int e = errno; if (pf_is_main()) { pf_take(); } errno = e; }
#endif

/* ---- labels for work without a frame of its own ---- */
int js98_pf_tag_push(const char *label) {
	if (pf_state <= 0 || !pf_rt || !pf_is_main()) { return 0; }
	int n = pf_ntag; if (n >= PF_MAXTAG) { return 0; }
	pf_tags[n].label = NULL; pf_barrier(); pf_tags[n].sf = pf_rt->current_stack_frame; pf_barrier(); pf_tags[n].label = label; pf_barrier(); pf_ntag = n + 1;
	return 1;
}
void js98_pf_tag_pop(int pushed) { if (pushed && pf_ntag > 0) { pf_ntag--; } }

/* ---- id tables (main thread only) ---- */
typedef struct { const void *p; int32_t magic; uint8_t kind; int id; } PfKey;
static PfKey *pf_keys; static int pf_keycap, pf_keyn;
static char **pf_names; static int pf_namen, pf_namecap;
typedef struct { const void *p; int32_t magic; char *name; } PfReg;
static PfReg *pf_regs; static int pf_regcap, pf_regn;
static int *pf_pool; static size_t pf_pooln, pf_poolcap;
typedef struct { uint32_t hash; uint32_t off; uint16_t len; } PfStack;
static PfStack *pf_stacks; static int pf_stackn, pf_stackcap; static int *pf_stackidx; static int pf_stackidxcap;
static uint32_t *pf_samples; static size_t pf_samplen, pf_samplecap;

static uint32_t pf_hash(const void *p, int32_t magic, int kind) { uint64_t x = (uint64_t)(uintptr_t)p * 0x9E3779B97F4A7C15ull ^ (uint64_t)(uint32_t)magic * 0xC2B2AE3D27D4EB4Full ^ (uint64_t)kind; x ^= x >> 29; return (uint32_t)x; }
static void *pf_grow(void *a, int *cap, size_t elem, int need) { if (need <= *cap) { return a; } int c = *cap ? *cap : 256; while (c < need) { c *= 2; } void *b = realloc(a, (size_t)c * elem); if (!b) { abort(); } *cap = c; return b; }
static void pf_keys_rehash(int cap) {
	PfKey *old = pf_keys; int oc = pf_keycap; pf_keys = calloc((size_t)cap, sizeof(PfKey)); if (!pf_keys) { abort(); } pf_keycap = cap; pf_keyn = 0;
	for (int i = 0; i < oc; i++) { if (old[i].kind && old[i].kind != PF_K_DEAD) { uint32_t j = pf_hash(old[i].p, old[i].magic, old[i].kind) & (cap - 1); while (pf_keys[j].kind) { j = (j + 1) & (cap - 1); } pf_keys[j] = old[i]; pf_keyn++; } }
	free(old);
}
static PfKey *pf_key_find(const void *p, int32_t magic, int kind) {
	if (!pf_keycap) { return NULL; }
	for (uint32_t j = pf_hash(p, magic, kind) & (pf_keycap - 1); pf_keys[j].kind; j = (j + 1) & (pf_keycap - 1)) {
		if (pf_keys[j].kind == kind && pf_keys[j].p == p && pf_keys[j].magic == magic) { return &pf_keys[j]; }
	}
	return NULL;
}
static int pf_add_name(const char *s) { pf_names = pf_grow(pf_names, &pf_namecap, sizeof(char *), pf_namen + 1); pf_names[pf_namen] = strdup(s); return pf_namen++; }
static const char *pf_reg_find(const void *p, int32_t magic) {
	if (!pf_regcap) { return NULL; }
	for (uint32_t j = pf_hash(p, magic, 0) & (pf_regcap - 1); pf_regs[j].name; j = (j + 1) & (pf_regcap - 1)) { if (pf_regs[j].p == p && pf_regs[j].magic == magic) { return pf_regs[j].name; } }
	return NULL;
}
static const char *pf_base(const char *f) { const char *b = f; for (const char *q = f; *q; q++) { if (*q == '/' || *q == '\\') { b = q + 1; } } return b; }
/* names given at run time to unnamed bytecode (methods, `const f = () => ...`): bytecode -> name; entries of freed bytecode are marked dead */
typedef struct { const void *p; char *name; uint8_t used; } PfHint;   /* used: 0 empty, 1 live, 2 dead */
static PfHint *pf_hints; static int pf_hintcap, pf_hintn;
static PfHint *pf_hint_find(const void *p) {
	if (!pf_hintcap) { return NULL; }
	for (uint32_t j = pf_hash(p, 0, 7) & (pf_hintcap - 1); pf_hints[j].used; j = (j + 1) & (pf_hintcap - 1)) { if (pf_hints[j].used == 1 && pf_hints[j].p == p) { return &pf_hints[j]; } }
	return NULL;
}
static void pf_name_hint(JSContext *ctx, JSValueConst func, JSAtom name, int flags) {
	if (pf_state <= 0 || ctx->rt != pf_rt || name == JS_ATOM_NULL || JS_VALUE_GET_TAG(func) != JS_TAG_OBJECT || !pf_is_main()) { return; }
	JSObject *o = JS_VALUE_GET_OBJ(func); if (!js_class_has_bytecode(o->class_id)) { return; }
	JSFunctionBytecode *b = o->u.func.function_bytecode; if (b->func_name != JS_ATOM_NULL || pf_hint_find(b)) { return; }
	char a[160], buf[180]; JS_AtomGetStrRT(ctx->rt, a, sizeof a, name); if (!*a) { return; }
	snprintf(buf, sizeof buf, "%s%s", flags & JS_PROP_HAS_GET ? "get " : flags & JS_PROP_HAS_SET ? "set " : "", a);
	if ((pf_hintn + 1) * 2 > pf_hintcap) {
		PfHint *old = pf_hints; int oc = pf_hintcap, c = oc ? oc * 2 : 16384; pf_hints = calloc((size_t)c, sizeof(PfHint)); if (!pf_hints) { abort(); } pf_hintcap = c; pf_hintn = 0;
		for (int i = 0; i < oc; i++) { if (old[i].used == 1) { uint32_t j = pf_hash(old[i].p, 0, 7) & (c - 1); while (pf_hints[j].used) { j = (j + 1) & (c - 1); } pf_hints[j] = old[i]; pf_hintn++; } else if (old[i].used == 2) { free(old[i].name); } }
		free(old);
	}
	uint32_t j = pf_hash(b, 0, 7) & (pf_hintcap - 1); while (pf_hints[j].used) { j = (j + 1) & (pf_hintcap - 1); }
	pf_hints[j].p = b; pf_hints[j].name = strdup(buf); pf_hints[j].used = 1; pf_hintn++;
}
static int pf_id(JSRuntime *rt, int kind, const void *p, int32_t magic) {
	PfKey *k = pf_key_find(p, magic, kind); if (k) { return k->id; }
	char buf[480], a[160], f[260];
	if (kind == PF_K_BC) {
		const JSFunctionBytecode *b = p;
		JS_AtomGetStrRT(rt, a, sizeof a, b->func_name); JS_AtomGetStrRT(rt, f, sizeof f, b->filename);
		if (b->func_name == JS_ATOM_NULL) { PfHint *h = pf_hint_find(b); snprintf(a, sizeof a, "%s", h ? h->name : ""); }
		snprintf(buf, sizeof buf, "%s %s:%d:%d", *a ? a : "(anonymous)", pf_base(f), b->line_num, b->col_num);
	} else if (kind == PF_K_CF) {
		const char *nm = pf_reg_find(p, magic); if (nm && *nm) { snprintf(buf, sizeof buf, "[native] %s", nm); } else { snprintf(buf, sizeof buf, "[native %p/%d]", p, (int)magic); }
	} else if (kind == PF_K_TAG) { snprintf(buf, sizeof buf, "%s", (const char *)p); }
	else { snprintf(buf, sizeof buf, "[class %d]", (int)magic); }
	if ((pf_keyn + 1) * 2 > pf_keycap) { pf_keys_rehash(pf_keycap ? pf_keycap * 2 : 4096); }
	uint32_t j = pf_hash(p, magic, kind) & (pf_keycap - 1); while (pf_keys[j].kind) { j = (j + 1) & (pf_keycap - 1); }
	pf_keys[j].p = p; pf_keys[j].magic = magic; pf_keys[j].kind = (uint8_t)kind; pf_keys[j].id = pf_add_name(buf); pf_keyn++;
	return pf_keys[j].id;
}
static int pf_stack_id(const int *ids, int n) {
	uint32_t h = 2166136261u; for (int i = 0; i < n; i++) { h = (h ^ (uint32_t)ids[i]) * 16777619u; }
	if ((pf_stackn + 1) * 2 > pf_stackidxcap) {
		int c = pf_stackidxcap ? pf_stackidxcap * 2 : 4096; free(pf_stackidx); pf_stackidx = malloc((size_t)c * sizeof(int)); if (!pf_stackidx) { abort(); } pf_stackidxcap = c;
		for (int i = 0; i < c; i++) { pf_stackidx[i] = -1; }
		for (int s = 0; s < pf_stackn; s++) { uint32_t j = pf_stacks[s].hash & (c - 1); while (pf_stackidx[j] >= 0) { j = (j + 1) & (c - 1); } pf_stackidx[j] = s; }
	}
	uint32_t j = h & (pf_stackidxcap - 1);
	for (; pf_stackidx[j] >= 0; j = (j + 1) & (pf_stackidxcap - 1)) {
		PfStack *s = &pf_stacks[pf_stackidx[j]]; if (s->hash == h && s->len == n && memcmp(pf_pool + s->off, ids, (size_t)n * sizeof(int)) == 0) { return pf_stackidx[j]; }
	}
	pf_stacks = pf_grow(pf_stacks, &pf_stackcap, sizeof(PfStack), pf_stackn + 1);
	if (pf_pooln + (size_t)n > pf_poolcap) { size_t c = pf_poolcap ? pf_poolcap : 65536; while (c < pf_pooln + (size_t)n) { c *= 2; } pf_pool = realloc(pf_pool, c * sizeof(int)); if (!pf_pool) { abort(); } pf_poolcap = c; }
	memcpy(pf_pool + pf_pooln, ids, (size_t)n * sizeof(int));
	pf_stacks[pf_stackn].hash = h; pf_stacks[pf_stackn].off = (uint32_t)pf_pooln; pf_stacks[pf_stackn].len = (uint16_t)n; pf_pooln += (size_t)n;
	pf_stackidx[j] = pf_stackn;
	return pf_stackn++;
}
/* raw samples -> ids; main thread, at a point where every sampled pointer is still valid */
static void pf_drain(void) {
	JSRuntime *rt = pf_rt; if (!rt) { return; }
	uint32_t h = pf_head; pf_barrier();
	int ids[PF_DEPTH + 1];
	while (pf_tail != h) {
		PfRaw *r = &pf_ring[pf_tail % PF_RING];
		int n = 0; for (int i = 0; i < r->n; i++) { ids[n++] = pf_id(rt, r->kind[i], r->p[i], r->magic[i]); }
		if (r->cut) { ids[n++] = -1; }
		int s = pf_stack_id(ids, n);
		/* the same stack as the sample before, within 100 ms of where that run started (an idle process, a long C call): one entry with the summed weight */
		if (pf_samplen >= 3 && pf_samples[pf_samplen - 2] == (uint32_t)s && r->t - pf_samples[pf_samplen - 3] < 100) { pf_samples[pf_samplen - 1] += r->w; pf_barrier(); pf_tail++; continue; }
		if (pf_samplen + 3 > pf_samplecap) { size_t c = pf_samplecap ? pf_samplecap * 2 : 65536; pf_samples = realloc(pf_samples, c * sizeof(uint32_t)); if (!pf_samples) { abort(); } pf_samplecap = c; }
		pf_samples[pf_samplen++] = r->t; pf_samples[pf_samplen++] = (uint32_t)s; pf_samples[pf_samplen++] = r->w;
		pf_barrier(); pf_tail++;
	}
}

/* ---- hooks called from quickjs.c (patch_quickjs.py) ---- */
static void pf_start(JSRuntime *rt) {
	pf_t0_ns = pf_now_ns(); pf_last_ns = pf_clock_ns();
#ifdef _WIN32
	FILETIME ft; GetSystemTimeAsFileTime(&ft); pf_t0_epoch = (double)((((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime) / 10000) - 11644473600000.0;
	if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &pf_main, 0, FALSE, DUPLICATE_SAME_ACCESS)) { pf_state = 0; return; }
	pf_stop = CreateEventA(NULL, TRUE, FALSE, NULL);
	pf_rt = rt;
	pf_thread = CreateThread(NULL, 64 * 1024, pf_sampler, NULL, 0, NULL);
	if (pf_thread) { SetThreadPriority(pf_thread, THREAD_PRIORITY_TIME_CRITICAL); } else { pf_rt = NULL; pf_state = 0; }
#else
	struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); pf_t0_epoch = ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
	pf_rt = rt;
	struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = pf_signal; sa.sa_flags = SA_RESTART; sigemptyset(&sa.sa_mask); sigaction(SIGPROF, &sa, NULL);
	struct sigevent sev; memset(&sev, 0, sizeof sev); sev.sigev_notify = SIGEV_THREAD_ID; sev.sigev_signo = SIGPROF; sev._sigev_un._tid = (pid_t)syscall(SYS_gettid);
	if (timer_create(CLOCK_THREAD_CPUTIME_ID, &sev, &pf_timer) == 0) {
		struct itimerspec it; memset(&it, 0, sizeof it); it.it_interval.tv_sec = pf_interval / 1000; it.it_interval.tv_nsec = (long)(pf_interval % 1000) * 1000000L; it.it_value = it.it_interval;
		timer_settime(pf_timer, 0, &it, NULL); pf_timer_on = 1;
	} else { pf_rt = NULL; pf_state = 0; }
#endif
}
static void pf_stop_sampler(void) {
#ifdef _WIN32
	if (pf_thread) { SetEvent(pf_stop); WaitForSingleObject(pf_thread, 1000); CloseHandle(pf_thread); pf_thread = NULL; }
#else
	if (pf_timer_on) { timer_delete(pf_timer); pf_timer_on = 0; }
#endif
}
/* process.exit ends the process without freeing the runtime: name what was sampled and write the file */
static void pf_atexit(void) { if (pf_rt && pf_is_main()) { pf_stop_sampler(); pf_drain(); pf_rt = NULL; pf_write(); } }
/* the first C function of the process decides (QJS98_PROFILE) and, when on, starts sampling the runtime it belongs to */
static void pf_reg(JSContext *ctx, const void *func, int magic, const char *name) {
	if (pf_state < 0) {
		const char *e = getenv("QJS98_PROFILE"); pf_state = e && *e && strcmp(e, "0") != 0;
		if (pf_state) {
			int ms = atoi(e); pf_interval = ms >= 1 && ms <= 100 ? ms : 5;
#ifdef _WIN32
			pf_tid = GetCurrentThreadId();
#else
			pf_thread_self = pthread_self();
#endif
			pf_start(ctx->rt);
			if (pf_state > 0) { atexit(pf_atexit); }
		}
	}
	if (pf_state <= 0 || !name || !*name || ctx->rt != pf_rt || !pf_is_main()) { return; }
	if ((pf_regn + 1) * 2 > pf_regcap) {
		PfReg *old = pf_regs; int oc = pf_regcap, c = oc ? oc * 2 : 8192; pf_regs = calloc((size_t)c, sizeof(PfReg)); if (!pf_regs) { abort(); } pf_regcap = c;
		for (int i = 0; i < oc; i++) { if (old[i].name) { uint32_t j = pf_hash(old[i].p, old[i].magic, 0) & (c - 1); while (pf_regs[j].name) { j = (j + 1) & (c - 1); } pf_regs[j] = old[i]; } }
		free(old);
	}
	uint32_t j = pf_hash(func, magic, 0) & (pf_regcap - 1);
	for (; pf_regs[j].name; j = (j + 1) & (pf_regcap - 1)) { if (pf_regs[j].p == func && pf_regs[j].magic == magic) { return; } }   /* the first name wins */
	pf_regs[j].p = func; pf_regs[j].magic = magic; pf_regs[j].name = strdup(name); pf_regn++;
}
static void pf_bytecode_freed(JSRuntime *rt, JSFunctionBytecode *b) {
	if (rt != pf_rt || !pf_is_main()) { return; }
	pf_drain();
	PfKey *k = pf_key_find(b, 0, PF_K_BC); if (k) { k->kind = PF_K_DEAD; }   /* the address may be reused by another function */
	PfHint *h = pf_hint_find(b); if (h) { h->used = 2; }
}
static void pf_poll(JSContext *ctx) { if (ctx->rt == pf_rt && pf_head - pf_tail >= PF_RING / 2 && pf_is_main()) { pf_drain(); } }

static void pf_put_str(FILE *f, const char *s) {
	fputc('"', f);
	for (; *s; s++) { unsigned char c = (unsigned char)*s; if (c == '"' || c == '\\') { fputc('\\', f); fputc(c, f); } else if (c < 0x20) { fprintf(f, "\\u%04x", c); } else { fputc(c, f); } }
	fputc('"', f);
}
static char pf_path[1100]; static uint64_t pf_last_write;
static void pf_write(void) {
	if (!*pf_path) { return; }
	char tmp[1110]; snprintf(tmp, sizeof tmp, "%s.tmp", pf_path);
	FILE *f = fopen(tmp, "wb"); if (!f) { return; }
#ifdef _WIN32
	fprintf(f, "{\"pid\":%lu,\"t0\":%.1f,\"intervalMs\":%d,\"clock\":\"wall\",\"dropped\":%u,\"names\":[", (unsigned long)GetCurrentProcessId(), pf_t0_epoch, pf_interval, (unsigned)pf_dropped);
#else
	fprintf(f, "{\"pid\":%d,\"t0\":%.1f,\"intervalMs\":%d,\"clock\":\"cpu\",\"dropped\":%u,\"names\":[", (int)getpid(), pf_t0_epoch, pf_interval, (unsigned)pf_dropped);
#endif
	for (int i = 0; i < pf_namen; i++) { if (i) { fputc(',', f); } pf_put_str(f, pf_names[i]); }
	fputs("],\"stacks\":[", f);
	for (int s = 0; s < pf_stackn; s++) { fputs(s ? ",[" : "[", f); for (int i = 0; i < pf_stacks[s].len; i++) { fprintf(f, i ? ",%d" : "%d", pf_pool[pf_stacks[s].off + i]); } fputc(']', f); }
	fputs("],\"samples\":[", f);
	for (size_t i = 0; i < pf_samplen; i++) { fprintf(f, i ? ",%u" : "%u", pf_samples[i]); }
	fputs("]}\n", f); fclose(f);
#ifdef _WIN32
	MoveFileExA(tmp, pf_path, MOVEFILE_REPLACE_EXISTING);
#else
	rename(tmp, pf_path);
#endif
}
/* from timeline98.h: each event-loop turn (drain), and when the timeline file is written (path = that file with .prof.json; force = asked from JavaScript) */
void js98_pf_tick(void) { if (pf_state > 0 && pf_is_main()) { pf_drain(); } }
void js98_pf_dump(const char *timeline_path, int force) {
	if (pf_state <= 0 || !pf_rt || !pf_is_main()) { return; }
	pf_drain();
	size_t l = strlen(timeline_path); if (l > 5 && l + 6 < sizeof pf_path && strcmp(timeline_path + l - 5, ".json") == 0) { memcpy(pf_path, timeline_path, l - 5); strcpy(pf_path + l - 5, ".prof.json"); }
	uint64_t now = pf_now_ns(); if (!force && now - pf_last_write < 10000000000ull) { return; }
	pf_last_write = now; pf_write();
}
static void pf_runtime_freed(JSRuntime *rt) {
	if (rt != pf_rt || !pf_is_main()) { return; }
	pf_stop_sampler(); pf_drain(); pf_rt = NULL; pf_write();
}
