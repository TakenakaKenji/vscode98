/* gc98.h - the schedule of QuickJS's cycle collector, included at the end of the patched quickjs.c (patch_quickjs.py).
 * Stock QuickJS collects (a full, non-incremental mark and sweep of the heap) from inside whatever allocation first finds the heap 50 % larger than after the previous
 * collection. In the renderer a collection takes ~95 ms on the sandbox (heap of the workbench's DOM, box trees and closures; the cycles are the garbage), and it ran inside
 * about a third of the control benchmark's actions, which is where their spread (300 to 500 ms for the same click) came from.
 * A process that calls __gcIdle(true) (the window process) gets two thresholds instead: the stock one is now "soft": the host runs the collection at an idle moment
 * (__gcWanted() tells it the soft threshold has been passed, __gcNow() collects); the one that forces a collection from inside an allocation is "hard" (QJS98_GC_HARD, percent of
 * growth after a collection, default 150), reached only when nobody was idle long enough. QJS98_GC=0 keeps the stock behaviour everywhere. */
static int gc98_idle;           /* this process collects at idle moments */
static size_t gc98_soft;        /* heap size above which an idle moment should collect */
static int gc98_hard_pct = -1;
static size_t gc98_runs, gc98_forced;
static void gc98_after(JSRuntime *rt) {
	if (gc98_hard_pct < 0) { const char *e = getenv("QJS98_GC_HARD"); int v = e && *e ? atoi(e) : 150; gc98_hard_pct = v >= 50 && v <= 1000 ? v : 150; const char *g = getenv("QJS98_GC"); if (g && g[0] == '0') { gc98_hard_pct = 50; } }
	size_t m = rt->malloc_state.malloc_size;
	gc98_soft = m + (m >> 1);
	rt->malloc_gc_threshold = gc98_idle ? m + (m / 100) * (size_t)gc98_hard_pct : gc98_soft;
}
static void gc98_forced_run(void) { gc98_forced++; }
void js98_gc_idle(JSRuntime *rt, int on) { const char *g = getenv("QJS98_GC"); gc98_idle = on && !(g && g[0] == '0'); gc98_after(rt); }
int js98_gc_wanted(JSRuntime *rt) { return gc98_idle && rt->malloc_state.malloc_size > gc98_soft; }
void js98_gc_now(JSRuntime *rt) { JS_RunGC(rt); gc98_runs++; gc98_after(rt); }
void js98_gc_stats(JSRuntime *rt, double *out) { out[0] = (double)gc98_runs; out[1] = (double)gc98_forced; out[2] = (double)rt->malloc_state.malloc_size; out[3] = (double)gc98_soft; out[4] = (double)rt->malloc_gc_threshold; }

/* QJS98_GC_CENSUS=1: before the cyclic garbage is freed, count it by class and by the first property names of its shape (to see what a collection frees); printed to stderr */
typedef struct { int cls; int pc; char names[3][24]; uint32_t n; size_t bytes; } Gc98Sig;
static Gc98Sig gc98_sig[256]; static int gc98_nsig; static int gc98_census_on = -1;
static void gc98_census(JSRuntime *rt) {
	if (gc98_census_on < 0) { const char *e = getenv("QJS98_GC_CENSUS"); gc98_census_on = e && *e >= '1' ? *e - '0' : 0; }
	if (!gc98_census_on) { return; }
	gc98_nsig = 0; uint32_t total = 0, bytecode = 0, other = 0; struct list_head *el;
	/* 2: the live objects instead of the garbage (what the ~0.8 s of marking is spent on) */
	struct list_head *census_list = gc98_census_on == 2 ? &rt->gc_obj_list : &rt->tmp_obj_list;
	list_for_each(el, census_list) {
		JSGCObjectHeader *p = list_entry(el, JSGCObjectHeader, link); total++;
		if (JS_GC_TYPE(p) == JS_GC_OBJ_TYPE_FUNCTION_BYTECODE) { bytecode++; continue; }
		if (JS_GC_TYPE(p) != JS_GC_OBJ_TYPE_JS_OBJECT) { other++; continue; }
		JSObject *o = (JSObject *)p; JSShape *sh = o->shape; Gc98Sig k; memset(&k, 0, sizeof k); k.cls = o->class_id; k.pc = sh ? sh->prop_count : 0;
		for (int i = 0, got = 0; sh && i < sh->prop_count && got < 3; i++) { if (get_shape_prop(sh)[i].atom == JS_ATOM_NULL) { continue; } char buf[64]; JS_AtomGetStrRT(rt, buf, sizeof buf, get_shape_prop(sh)[i].atom); strncpy(k.names[got], buf, 23); got++; }
		int j; for (j = 0; j < gc98_nsig; j++) { Gc98Sig *q = &gc98_sig[j]; if (q->cls == k.cls && q->pc == k.pc && !strcmp(q->names[0], k.names[0]) && !strcmp(q->names[1], k.names[1]) && !strcmp(q->names[2], k.names[2])) { break; } }
		if (j == gc98_nsig) { if (gc98_nsig == 256) { continue; } gc98_sig[gc98_nsig++] = k; }
		gc98_sig[j].n++;
	}
	if (gc98_census_on == 2) { for (int r = 0; r < 14; r++) { int best = -1; for (int j = 0; j < gc98_nsig; j++) { if (gc98_sig[j].n && (best < 0 || gc98_sig[j].n > gc98_sig[best].n)) { best = j; } } if (best < 0) { break; } } }
	/* who references the Box-shaped objects (first property "el", at least 20 properties) among the garbage? */
	if (gc98_census_on == 1) {
		enum { MAXB = 1 << 20 }; static JSObject **boxes; static int nbox;
		if (!boxes) { boxes = malloc(sizeof(JSObject *) * MAXB); } nbox = 0;
		list_for_each(el, &rt->tmp_obj_list) { JSGCObjectHeader *p = list_entry(el, JSGCObjectHeader, link); if (JS_GC_TYPE(p) != JS_GC_OBJ_TYPE_JS_OBJECT) { continue; } JSObject *o = (JSObject *)p; JSShape *sh = o->shape; if (o->class_id == 1 && sh && sh->prop_count >= 20) { char b[64]; JS_AtomGetStrRT(rt, b, sizeof b, get_shape_prop(sh)[0].atom); if (!strcmp(b, "el") && nbox < MAXB) { boxes[nbox++] = o; } } }
		/* sorted lookup by address */
		for (int i = 1; i < nbox; i++) { JSObject *x = boxes[i]; int j = i - 1; while (j >= 0 && boxes[j] > x) { boxes[j + 1] = boxes[j]; j--; } boxes[j + 1] = x; }
		#define ISBOX(v) ({ int lo = 0, hi = nbox - 1, f = 0; if (JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT) { JSObject *q = JS_VALUE_GET_OBJ(v); while (lo <= hi) { int m = (lo + hi) / 2; if (boxes[m] == q) { f = 1; break; } if (boxes[m] < q) lo = m + 1; else hi = m - 1; } } f; })
		static Gc98Sig ref[64]; int nref = 0; memset(ref, 0, sizeof ref);
		list_for_each(el, &rt->tmp_obj_list) {
			JSGCObjectHeader *p = list_entry(el, JSGCObjectHeader, link); if (JS_GC_TYPE(p) != JS_GC_OBJ_TYPE_JS_OBJECT) { continue; } JSObject *o = (JSObject *)p; JSShape *sh = o->shape; int hits = 0; Gc98Sig k; memset(&k, 0, sizeof k); k.cls = o->class_id;
			if (o->class_id == 1 || o->class_id == 13) { for (int i = 0; sh && i < sh->prop_count; i++) { if (get_shape_prop(sh)[i].atom == JS_ATOM_NULL) { continue; } JSProperty *pr = &o->prop[i]; if (!(get_shape_prop(sh)[i].flags & JS_PROP_TMASK) && ISBOX(pr->u.value)) { hits++; if (!k.names[0][0]) { char b[64]; JS_AtomGetStrRT(rt, b, sizeof b, get_shape_prop(sh)[i].atom); strncpy(k.names[0], b, 23); } } } }
			if (o->class_id == 2 && o->fast_array) { for (uint32_t i = 0; i < o->u.array.count; i++) { if (ISBOX(o->u.array.u.values[i])) { hits++; strcpy(k.names[0], "[elements]"); break; } } }
			if (o->class_id == JS_CLASS_MAP || o->class_id == JS_CLASS_SET || o->class_id == JS_CLASS_WEAKMAP || o->class_id == JS_CLASS_WEAKSET) { JSMapState *ms = o->u.map_state; struct list_head *e2; if (ms) { list_for_each(e2, &ms->records) { JSMapRecord *mr = list_entry(e2, JSMapRecord, link); if (!mr->empty && (ISBOX(mr->key) || ISBOX(mr->value))) { hits++; strcpy(k.names[0], o->class_id == JS_CLASS_MAP ? "Map entry" : o->class_id == JS_CLASS_SET ? "Set entry" : o->class_id == JS_CLASS_WEAKMAP ? "WeakMap entry" : "WeakSet entry"); } } } }
			if (o->class_id == 13 && o->u.func.function_bytecode) { JSFunctionBytecode *fb = o->u.func.function_bytecode; for (int i = 0; i < fb->closure_var_count; i++) { JSVarRef *vr = o->u.func.var_refs[i]; if (vr && ISBOX(*vr->pvalue)) { hits++; strcpy(k.names[1], "(closure var)"); break; } } }
			if (!hits) { continue; } if (o->class_id == 1) { k.pc = sh ? sh->prop_count : 0; char b[64]; if (sh && sh->prop_count) { JS_AtomGetStrRT(rt, b, sizeof b, get_shape_prop(sh)[0].atom); strncpy(k.names[2], b, 23); } }
			int j; for (j = 0; j < nref; j++) { if (ref[j].cls == k.cls && ref[j].pc == k.pc && !strcmp(ref[j].names[0], k.names[0]) && !strcmp(ref[j].names[1], k.names[1]) && !strcmp(ref[j].names[2], k.names[2])) { break; } } if (j == nref) { if (nref == 64) { continue; } ref[nref++] = k; } ref[j].n += hits;
		}
		list_for_each(el, &rt->tmp_obj_list) { JSGCObjectHeader *p = list_entry(el, JSGCObjectHeader, link); if (JS_GC_TYPE(p) != JS_GC_OBJ_TYPE_VAR_REF) { continue; } JSVarRef *vr = (JSVarRef *)p; if (vr->pvalue && ISBOX(*vr->pvalue)) { Gc98Sig k; memset(&k, 0, sizeof k); strcpy(k.names[0], "captured variable (JSVarRef)"); int j; for (j = 0; j < nref; j++) { if (!strcmp(ref[j].names[0], k.names[0])) { break; } } if (j == nref) { if (nref == 64) { continue; } ref[nref++] = k; } ref[j].n++; } }
		fprintf(stderr, "[gc census] %d Box objects among the garbage; who references them (class, props, first name | property or element that holds a box):\n", nbox);
		for (int r = 0; r < 8; r++) { int best = -1; for (int j = 0; j < nref; j++) { if (ref[j].n && (best < 0 || ref[j].n > ref[best].n)) { best = j; } } if (best < 0) { break; } fprintf(stderr, "[gc census]   %7u refs from class %d, %d props, first %s | %s%s\n", ref[best].n, ref[best].cls, ref[best].pc, ref[best].names[2], ref[best].names[0], ref[best].names[1]); ref[best].n = 0; }
	}
	fprintf(stderr, "[gc census] heap %zu MB: %u %s objects (%u function bytecode, %u other), top shapes (class, props, first names):\n", rt->malloc_state.malloc_size >> 20, total, gc98_census_on == 2 ? "LIVE" : "cyclic", bytecode, other);
	for (int r = 0; r < 14; r++) { int best = -1; for (int j = 0; j < gc98_nsig; j++) { if (gc98_sig[j].n && (best < 0 || gc98_sig[j].n > gc98_sig[best].n)) { best = j; } } if (best < 0) { break; } Gc98Sig *q = &gc98_sig[best]; fprintf(stderr, "[gc census]  %7u  class %d, %d props: %s, %s, %s\n", q->n, q->cls, q->pc, q->names[0], q->names[1], q->names[2]); q->n = 0; }
}
