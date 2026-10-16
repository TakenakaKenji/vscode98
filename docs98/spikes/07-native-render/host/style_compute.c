/* spike:style, phase 2 - the computed-value step of css.js computeStyle in C (included by style.c, which owns the atoms and the hash maps).
 *
 * Per element: the cascade over the matched rules' declaration blocks and the inline style (the winning declaration per property), the custom
 * properties (scopes: an element's own declarations over its parent's scope, as css.js VarScope), var() substitution (css.js substituteVars), the
 * global keywords (initial/inherit/unset/revert), font-size and color first, then every declared property's value. Values are the JavaScript values
 * css.js parseValue produces: C keeps them in a cache keyed like css.js parseValueCached and asks JavaScript (the parse callback) only on a miss,
 * so a value is by construction the same object the JavaScript engine would use. The values are written into the `out` object JavaScript passes
 * in (all properties pre-filled with initial and inherited values); the post-processing (border widths, currentcolor, blockification) stays in
 * css.js finishComputed. anchor() values are left to JavaScript (compute returns -2).
 * Driver: native_style.js (engine.compute); oracle: --style verify compares every element against the JavaScript computeStyle.
 */

/* ---------------------------------------------------------------- property table (from css.js PROPS) */
typedef struct { JSAtom atom; int inh, isLen; JSValue init; } CProp;
static CProp *cprops; static int ncprops; static int P_FONT_SIZE = -1, P_COLOR = -1;
static JSValue colorInit, parseCb; static JSContext *cctx; static JSAtom A_length;
static struct { const char *name; double px; } kwFontSizes[] = { { "xx-small", 9 }, { "x-small", 10 }, { "small", 13 }, { "medium", 16 }, { "large", 18 }, { "x-large", 24 }, { "xx-large", 32 }, { "xxx-large", 48 } };

/* ---------------------------------------------------------------- strings: JavaScript-compatible trim and case-insensitive tests */
/* the length of the white space or line terminator (ECMAScript WhiteSpace/LineTerminator) starting at s[i], 0 if none */
static int ws_at(const char *s, int n, int i) {
	unsigned c = (uint8_t)s[i];
	if (c == ' ' || (c >= 9 && c <= 13)) { return 1; }
	if (c == 0xC2 && i + 1 < n && (uint8_t)s[i + 1] == 0xA0) { return 2; }   /* U+00A0 */
	if (c == 0xE1 && i + 2 < n && (uint8_t)s[i + 1] == 0x9A && (uint8_t)s[i + 2] == 0x80) { return 3; }   /* U+1680 */
	if (c == 0xE2 && i + 2 < n) { unsigned b = (uint8_t)s[i + 1], d = (uint8_t)s[i + 2]; if (b == 0x80 && ((d >= 0x80 && d <= 0x8A) || d == 0xA8 || d == 0xA9 || d == 0xAF)) { return 3; } if (b == 0x81 && d == 0x9F) { return 3; } }   /* U+2000-200A, 2028, 2029, 202F, 205F */
	if (c == 0xE3 && i + 2 < n && (uint8_t)s[i + 1] == 0x80 && (uint8_t)s[i + 2] == 0x80) { return 3; }   /* U+3000 */
	if (c == 0xEF && i + 2 < n && (uint8_t)s[i + 1] == 0xBB && (uint8_t)s[i + 2] == 0xBF) { return 3; }   /* U+FEFF */
	return 0;
}
static int ws_before(const char *s, int i) {   /* the length of the white space ending at s[i-1] */
	if (i >= 1) { unsigned c = (uint8_t)s[i - 1]; if (c == ' ' || (c >= 9 && c <= 13)) { return 1; } }
	if (i >= 2 && (uint8_t)s[i - 2] == 0xC2 && (uint8_t)s[i - 1] == 0xA0) { return 2; }
	if (i >= 3 && ws_at(s, i, i - 3) == 3) { return 3; }
	return 0;
}
static void trim(const char **s, int *n) { int a = 0, b = *n, k; while (a < b && (k = ws_at(*s, b, a)) > 0) { a += k; } while (b > a && (k = ws_before(*s, b)) > 0) { b -= k; } *s += a; *n = b - a; }
static int ieq(const char *s, int n, const char *lit) { int m = (int)strlen(lit); if (n != m) { return 0; } for (int i = 0; i < n; i++) { if (lc((uint8_t)s[i]) != lit[i]) { return 0; } } return 1; }
static int icontains(const char *s, int n, const char *lit) { int m = (int)strlen(lit); for (int i = 0; i + m <= n; i++) { int k = 0; while (k < m && lc((uint8_t)s[i + k]) == lit[k]) { k++; } if (k == m) { return 1; } } return 0; }
static int contains(const char *s, int n, const char *lit) { int m = (int)strlen(lit); for (int i = 0; i + m <= n; i++) { if (memcmp(s + i, lit, (size_t)m) == 0) { return 1; } } return 0; }
static int atom_find(const char *s, int len) { if (!atabcap) { return -1; } uint32_t h = fnv(2166136261u, s, len) & (atabcap - 1); for (; atab[h]; h = (h + 1) & (atabcap - 1)) { const Atom *a = &atoms[atab[h] - 1]; if (a->len == len && memcmp(a->s, s, (size_t)len) == 0) { return atab[h] - 1; } } return -1; }
typedef struct { char *s; int n; } Str;   /* malloc'd, NUL-terminated */
static Str str_dup(const char *s, int n) { Str r; r.s = malloc((size_t)n + 1); memcpy(r.s, s, (size_t)n); r.s[n] = 0; r.n = n; return r; }

/* ---------------------------------------------------------------- declaration blocks (css.js expandDecls results: one per rule, one per inline style) */
typedef struct { int pidx, custom, imp, pend, hasVar; Str val; } Decl;   /* pidx: property index or -1; custom: atom of a custom property or -1; pend: pending shorthand + 1 */
typedef struct { int used, n; Decl *d; } Block;
static Block *blocks; static int nblocks, capblocks; static Vec freeBlocks;
static void free_block(Block *b) { for (int i = 0; i < b->n; i++) { free(b->d[i].val.s); } free(b->d); memset(b, 0, sizeof *b); }

/* ---------------------------------------------------------------- custom-property scopes (css.js VarScope) */
typedef struct { int name; int tomb; Str val; } VEnt;
typedef struct SubE { uint32_t h; Str key; Str res; int isNull; } SubE;   /* substitution cache entry (key.s NULL: empty) */
typedef struct { int used, refs, parent, depth; uint32_t gen; VEnt *own; int nown, capown; IMap ix; int eqId; uint32_t eqGen; SubE *sub; int nsub, capsub; } Scope;
static Scope *scopes; static int nscopes; static Vec freeScopes;
static void sub_clear(Scope *s) { for (int i = 0; i < s->capsub; i++) { if (s->sub[i].key.s) { free(s->sub[i].key.s); free(s->sub[i].res.s); } } free(s->sub); s->sub = NULL; s->nsub = s->capsub = 0; }
static void scope_unref(int id);
static void scope_free(int id) { Scope *s = &scopes[id]; int p = s->parent; for (int i = 0; i < s->nown; i++) { free(s->own[i].val.s); } free(s->own); free(s->ix.keys); free(s->ix.vals); sub_clear(s); uint32_t g = s->gen; memset(s, 0, sizeof *s); s->gen = g + 1; vpush(&freeScopes, id); if (p >= 0) { scope_unref(p); } }
static void scope_unref(int id) { if (id <= 0 || id >= nscopes || !scopes[id].used) { return; } if (--scopes[id].refs <= 0) { scope_free(id); } }
static int own_find(const Scope *s, int name) { if (s->ix.cap) { return imap_get(&s->ix, name); } for (int i = 0; i < s->nown; i++) { if (s->own[i].name == name) { return i; } } return -1; }
static void own_set(Scope *s, int name, const char *v, int vn, int tomb) {
	int i = own_find(s, name);
	if (i < 0) { if (s->nown == s->capown) { s->capown = s->capown ? s->capown * 2 : 8; s->own = realloc(s->own, (size_t)s->capown * sizeof(VEnt)); } i = s->nown++; s->own[i].name = name; s->own[i].val.s = NULL; if (s->ix.cap || s->nown > 8) { if (!s->ix.cap) { for (int k = 0; k < s->nown - 1; k++) { imap_put(&s->ix, s->own[k].name, k); } } imap_put(&s->ix, name, i); } }
	else { free(s->own[i].val.s); s->own[i].val.s = NULL; }
	s->own[i].tomb = tomb; if (!tomb) { s->own[i].val = str_dup(v, vn); } else { s->own[i].val.n = 0; }
}
/* the value of a custom property in a scope (NULL: undefined) */
static const Str *scope_get(int id, int name) {
	for (int s = id; s >= 0; s = scopes[s].parent) { int i = own_find(&scopes[s], name); if (i >= 0) { return scopes[s].own[i].tomb ? NULL : &scopes[s].own[i].val; } if (s == 0) { break; } }
	return NULL;
}
static int scope_new(int parent) {
	int id; if (freeScopes.n) { id = freeScopes.v[--freeScopes.n]; } else { if (nscopes % 256 == 0) { scopes = realloc(scopes, (size_t)(nscopes + 256) * sizeof(Scope)); memset(scopes + nscopes, 0, 256 * sizeof(Scope)); } id = nscopes++; }
	Scope *s = &scopes[id]; uint32_t g = s->gen; memset(s, 0, sizeof *s); s->gen = g; s->used = 1; s->refs = 1; s->eqId = -1; s->parent = parent; s->depth = parent >= 0 ? scopes[parent].depth + 1 : 0; if (parent > 0) { scopes[parent].refs++; }
	return id;
}
/* the defined entries of a scope's whole chain, nearest first (each name once) */
static void scope_collect(int id, Vec *names, Vec *idx /* scope id, entry index pairs */) {
	IMap seen = { 0 };
	for (int s = id; s >= 0; s = scopes[s].parent) {
		for (int i = 0; i < scopes[s].nown; i++) { int nm = scopes[s].own[i].name; if (imap_get(&seen, nm) >= 0) { continue; } imap_put(&seen, nm, 1); if (!scopes[s].own[i].tomb) { vpush(names, nm); vpush(idx, s); vpush(idx, i); } }
		if (s == 0) { break; }
	}
	free(seen.keys); free(seen.vals);
}
static void scope_flatten(int id) {   /* css.js VarScope.flatten: the scope holds the whole chain's entries and no parent */
	Scope *s = &scopes[id]; Vec names = { 0 }, idx = { 0 }; scope_collect(s->parent, &names, &idx);
	for (int k = 0; k < names.n; k++) { const VEnt *e = &scopes[idx.v[2 * k]].own[idx.v[2 * k + 1]]; own_set(&scopes[id], names.v[k], e->val.s, e->val.n, 0); }
	free(names.v); free(idx.v); s = &scopes[id]; int p = s->parent; s->parent = -1; s->depth = 0; if (p > 0) { scope_unref(p); }
}
static int same_own(const Scope *a, const Scope *b) {
	if (a->nown != b->nown) { return 0; }
	for (int i = 0; i < a->nown; i++) { int j = own_find(b, a->own[i].name); if (j < 0) { return 0; } const VEnt *x = &a->own[i], *y = &b->own[j]; if (x->tomb != y->tomb || (!x->tomb && (x->val.n != y->val.n || memcmp(x->val.s, y->val.s, (size_t)x->val.n) != 0))) { return 0; } }
	return 1;
}
static int same_map(int a, int b) {
	Vec na = { 0 }, ia = { 0 }, nb = { 0 }, ib = { 0 }; scope_collect(a, &na, &ia); scope_collect(b, &nb, &ib); int same = na.n == nb.n;
	for (int k = 0; same && k < na.n; k++) { const Str *x = &scopes[ia.v[2 * k]].own[ia.v[2 * k + 1]].val; const Str *y = scope_get(b, na.v[k]); if (!y || y->n != x->n || memcmp(y->s, x->s, (size_t)x->n) != 0) { same = 0; } }
	free(na.v); free(ia.v); free(nb.v); free(ib.v); return same;
}
/* css.js varsEqual: same defined custom properties with the same values; an equal pair is remembered (only the latest) */
static int scope_equal(int a, int b) {
	if (a == b) { return 1; } Scope *sa = &scopes[a], *sb = &scopes[b];
	if (sa->eqId == b && sa->eqGen == sb->gen) { return 1; }
	int same;
	if (sa->parent >= 0 && sb->parent >= 0 && a != 0 && b != 0 && same_own(sa, sb) && scope_equal(sa->parent, sb->parent)) { same = 1; } else { same = same_map(a, b); }
	if (same) { sa = &scopes[a]; sb = &scopes[b]; sa->eqId = b; sa->eqGen = sb->gen; sb->eqId = -1; }
	return same;
}

/* ---------------------------------------------------------------- var() substitution (css.js substituteVars and VAR_RE) */
static inline int is_word(int c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-'; }
static inline int is_sp(int c) { return c == ' ' || (c >= 9 && c <= 13); }
/* /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/ : the first match at or after `from`; returns its start or -1 */
static int var_find(const char *s, int n, int from, int *end, int *nm0, int *nm1, int *fb0, int *fb1) {
	for (int i = from; i + 4 <= n; i++) {
		if (memcmp(s + i, "var(", 4) != 0) { continue; }
		int j = i + 4; while (j < n && is_sp((uint8_t)s[j])) { j++; }
		if (j + 1 >= n || s[j] != '-' || s[j + 1] != '-') { continue; } int a = j; j += 2; if (j >= n || !is_word((uint8_t)s[j])) { continue; } while (j < n && is_word((uint8_t)s[j])) { j++; } int b = j;   /* --[\w-]+ */
		while (j < n && is_sp((uint8_t)s[j])) { j++; }
		int f0 = -1, f1 = -1;
		if (j < n && s[j] == ',') {
			int k = j + 1, c0 = k;
			for (;;) { if (k >= n) { break; } char c = s[k]; if (c != '(' && c != ')') { k++; continue; } if (c == '(') { int q = k + 1; while (q < n && s[q] != '(' && s[q] != ')') { q++; } if (q < n && s[q] == ')') { k = q + 1; continue; } } break; }
			if (k < n && s[k] == ')') { f0 = c0; f1 = k; *end = k + 1; *nm0 = a; *nm1 = b; *fb0 = f0; *fb1 = f1; return i; }
			continue;   /* (the group cannot be skipped: ')' would have to follow the name) */
		}
		if (j < n && s[j] == ')') { *end = j + 1; *nm0 = a; *nm1 = b; *fb0 = -1; *fb1 = -1; return i; }
	}
	return -1;
}
/* returns 1 and a malloc'd result, or 0 for null */
static int substitute(const char *v, int vn, int scope, int depth, Str *out) {
	if (!contains(v, vn, "var(")) { *out = str_dup(v, vn); return 1; }
	if (depth > 10) { return 0; }
	Str cur = str_dup(v, vn); int guard = 0;
	for (;;) {
		int end, a, b, f0, f1; int m = var_find(cur.s, cur.n, 0, &end, &a, &b, &f0, &f1); if (m < 0 || guard++ >= 50) { break; }
		const char *rp; int rn; Str tmp = { 0 }; int nm = atom_find(cur.s + a, b - a); const Str *val = nm >= 0 ? scope_get(scope, nm) : NULL;
		if (val) { rp = val->s; rn = val->n; } else if (f0 >= 0) { rp = cur.s + f0; rn = f1 - f0; trim(&rp, &rn); } else { free(cur.s); return 0; }
		if (contains(rp, rn, "var(")) { if (!substitute(rp, rn, scope, depth + 1, &tmp)) { free(cur.s); return 0; } rp = tmp.s; rn = tmp.n; }
		Str nx; nx.n = m + rn + (cur.n - end); nx.s = malloc((size_t)nx.n + 1); memcpy(nx.s, cur.s, (size_t)m); memcpy(nx.s + m, rp, (size_t)rn); memcpy(nx.s + m + rn, cur.s + end, (size_t)(cur.n - end)); nx.s[nx.n] = 0;
		free(tmp.s); free(cur.s); cur = nx;
	}
	*out = cur; return 1;
}
/* substitution after the scope is complete (css.js VarScope.substitute): cached per scope */
static int substitute_cached(const char *v, int vn, int scope, Str *out) {
	Scope *s = &scopes[scope]; uint32_t h = fnv(2166136261u, v, vn);
	if (s->capsub) { for (uint32_t i = h & (uint32_t)(s->capsub - 1);; i = (i + 1) & (uint32_t)(s->capsub - 1)) { SubE *e = &s->sub[i]; if (!e->key.s) { break; } if (e->h == h && e->key.n == vn && memcmp(e->key.s, v, (size_t)vn) == 0) { if (e->isNull) { return 0; } *out = str_dup(e->res.s, e->res.n); return 1; } } }
	Str r = { 0 }; int ok = substitute(v, vn, scope, 0, &r);
	s = &scopes[scope]; if (s->nsub > 5000) { sub_clear(s); }
	if ((s->nsub + 1) * 2 > s->capsub) { int oc = s->capsub; SubE *old = s->sub; s->capsub = oc ? oc * 2 : 64; s->sub = calloc((size_t)s->capsub, sizeof(SubE)); for (int i = 0; i < oc; i++) { if (old[i].key.s) { uint32_t k = old[i].h & (uint32_t)(s->capsub - 1); while (s->sub[k].key.s) { k = (k + 1) & (uint32_t)(s->capsub - 1); } s->sub[k] = old[i]; } } free(old); }
	uint32_t k = h & (uint32_t)(s->capsub - 1); while (s->sub[k].key.s) { k = (k + 1) & (uint32_t)(s->capsub - 1); }
	s->sub[k].h = h; s->sub[k].key = str_dup(v, vn); s->sub[k].isNull = !ok; s->sub[k].res = ok ? str_dup(r.s, r.n) : (Str){ 0 }; s->nsub++;
	if (!ok) { return 0; } *out = r; return 1;
}

/* ---------------------------------------------------------------- the value cache (css.js parseValueCached) */
enum { M_VALUE = 0, M_FONT_SIZE = 1, M_COLOR = 2, M_PENDING = 3 };
typedef struct { uint32_t h; int mode, a, b, ctx, colLen; double fs, col[4]; Str key; JSValue v; Str rs; int rnull, used; } PEnt;
static PEnt *pcache; static uint32_t pcap, pcount; static long statHits, statMisses;
static void pcache_clear(void) { for (uint32_t i = 0; i < pcap; i++) { if (pcache[i].used) { free(pcache[i].key.s); free(pcache[i].rs.s); JS_FreeValue(cctx, pcache[i].v); } } memset(pcache, 0, pcap * sizeof(PEnt)); pcount = 0; }
static uint32_t pkey_hash(int mode, int a, int b, const char *s, int n, int ctxdep, double fs, const double *col, int colLen) {
	uint32_t h = fnv(2166136261u, s, n); h = (h ^ (uint32_t)mode) * 16777619u; h = (h ^ (uint32_t)a) * 16777619u; h = (h ^ (uint32_t)b) * 16777619u;
	if (ctxdep) { h = fnv(h, (const char *)&fs, sizeof fs); h = fnv(h, (const char *)col, (int)(sizeof(double) * (size_t)colLen)); }
	return h;
}
static PEnt *pcache_find(int mode, int a, int b, const char *s, int n, int ctxdep, double fs, const double *col, int colLen, uint32_t *ph) {
	if (!pcap) { pcap = 131072; pcache = calloc(pcap, sizeof(PEnt)); }
	uint32_t h = pkey_hash(mode, a, b, s, n, ctxdep, fs, col, colLen); *ph = h;
	for (uint32_t i = h & (pcap - 1);; i = (i + 1) & (pcap - 1)) {
		PEnt *e = &pcache[i]; if (!e->used) { return NULL; }
		if (e->h == h && e->mode == mode && e->a == a && e->b == b && e->ctx == ctxdep && e->key.n == n && memcmp(e->key.s, s, (size_t)n) == 0 && (!ctxdep || (e->fs == fs && e->colLen == colLen && memcmp(e->col, col, sizeof(double) * (size_t)colLen) == 0))) { return e; }
	}
}
static PEnt *pcache_add(uint32_t h, int mode, int a, int b, const char *s, int n, int ctxdep, double fs, const double *col, int colLen) {
	if (pcount > 50000) { pcache_clear(); }
	uint32_t i = h & (pcap - 1); while (pcache[i].used) { i = (i + 1) & (pcap - 1); }
	PEnt *e = &pcache[i]; memset(e, 0, sizeof *e); e->used = 1; e->h = h; e->mode = mode; e->a = a; e->b = b; e->ctx = ctxdep; e->fs = fs; e->colLen = colLen; if (colLen) { memcpy(e->col, col, sizeof(double) * (size_t)colLen); } e->key = str_dup(s, n); e->v = JS_UNDEFINED; pcount++;
	return e;
}
/* JavaScript's answer for a cache miss: parseCb(mode, a, b, string, fontSize, color) */
static JSValue call_parse(int mode, int a, int b, const char *s, int n, double fs, JSValueConst color) {
	JSValue args[6] = { JS_NewInt32(cctx, mode), JS_NewInt32(cctx, a), JS_NewInt32(cctx, b), JS_NewStringLen(cctx, s, (size_t)n), JS_NewFloat64(cctx, fs), JS_DupValue(cctx, color) };
	JSValue r = JS_Call(cctx, parseCb, JS_UNDEFINED, 6, args); for (int i = 0; i < 6; i++) { JS_FreeValue(cctx, args[i]); }
	return r;
}

/* ---------------------------------------------------------------- compute */
typedef struct { int name; Decl *d; } CWin;
static Decl **win; static uint32_t *winStamp, *declStamp; static int *winList; static uint32_t callStamp;
static CWin *cwin; static int ncwin, capcwin; static int *cwSlot; static uint32_t *cwStamp; static int cwCap;
static long statComputes, statFallbacks;
static void ensure_cw(void) { if (cwCap < natoms) { int nc = natoms + 1024; cwSlot = realloc(cwSlot, (size_t)nc * sizeof(int)); cwStamp = realloc(cwStamp, (size_t)nc * sizeof(uint32_t)); memset(cwStamp + cwCap, 0, (size_t)(nc - cwCap) * sizeof(uint32_t)); cwCap = nc; } }
static void cascade_block(const Block *b, int *nwin) {
	for (int i = 0; i < b->n; i++) {
		Decl *d = &b->d[i];
		if (d->custom >= 0) {
			if (cwStamp[d->custom] != callStamp) { cwStamp[d->custom] = callStamp; if (ncwin == capcwin) { capcwin = capcwin ? capcwin * 2 : 64; cwin = realloc(cwin, (size_t)capcwin * sizeof(CWin)); } cwSlot[d->custom] = ncwin; cwin[ncwin].name = d->custom; cwin[ncwin].d = d; ncwin++; }
			else { CWin *w = &cwin[cwSlot[d->custom]]; if (d->imp || !w->d->imp) { w->d = d; } }
		} else if (d->pidx >= 0) {
			int p = d->pidx; if (winStamp[p] != callStamp) { winStamp[p] = callStamp; win[p] = d; winList[(*nwin)++] = p; } else if (d->imp || !win[p]->imp) { win[p] = d; }
		}
	}
}
static int read_color(JSValueConst c, double *col) {   /* the numbers of a color array (css.js color.join(',') in the cache key) */
	JSValue lv = JS_GetProperty(cctx, c, A_length); int32_t L = 0; JS_ToInt32(cctx, &L, lv); JS_FreeValue(cctx, lv); if (L > 4) { L = 4; } if (L < 0) { L = 0; }
	for (int i = 0; i < L; i++) { JSValue x = JS_GetPropertyUint32(cctx, c, (uint32_t)i); JS_ToFloat64(cctx, &col[i], x); JS_FreeValue(cctx, x); }
	return L;
}
/* compute(blocks: Int32Array, n, inlineBlock, parentScope, parentValues|null, out, rootFontSize, vw, vh) -> the element's scope id, or -2: let JavaScript compute this element */
static JSValue js_compute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int32_t *bl; int bcap; int32_t nb, inl, pscope; if (get_i32(ctx, argv[0], &bl, &bcap) || JS_ToInt32(ctx, &nb, argv[1]) || JS_ToInt32(ctx, &inl, argv[2]) || JS_ToInt32(ctx, &pscope, argv[3])) { return JS_ThrowTypeError(ctx, "compute: bad arguments"); }
	if (!ncprops) { return JS_ThrowTypeError(ctx, "compute: computeInit first"); }
	if (pscope < 0 || pscope >= nscopes || !scopes[pscope].used) { return JS_ThrowRangeError(ctx, "compute: bad parent scope %d", pscope); }
	JSValueConst pvals = argv[4], out = argv[5]; const int hasParent = JS_IsObject(pvals);
	cctx = ctx; statComputes++; ensure_cw(); callStamp++; if (!callStamp) { memset(winStamp, 0, (size_t)ncprops * sizeof(uint32_t)); memset(declStamp, 0, (size_t)ncprops * sizeof(uint32_t)); memset(cwStamp, 0, (size_t)cwCap * sizeof(uint32_t)); callStamp = 1; }
	ncwin = 0; int nwin = 0;
	for (int i = 0; i < nb && i < bcap; i++) { int b = bl[i]; if (b < 0 || b >= nblocks || !blocks[b].used) { return JS_ThrowRangeError(ctx, "compute: bad block %d", b); } cascade_block(&blocks[b], &nwin); }
	if (inl >= 0) { if (inl >= nblocks || !blocks[inl].used) { return JS_ThrowRangeError(ctx, "compute: bad inline block %d", inl); } cascade_block(&blocks[inl], &nwin); }
	/* custom properties first, in the order they were first declared */
	int scope = pscope, owned = 0;
	for (int k = 0; k < ncwin; k++) {
		Decl *d = cwin[k].d; Str v = { 0 }; int ok = d->hasVar ? substitute(d->val.s, d->val.n, scope, 0, &v) : (v = str_dup(d->val.s, d->val.n), 1);
		if (!owned) { scope = scope_new(pscope); owned = 1; if (scopes[scope].depth > 12) { scope_flatten(scope); } }
		if (ok) { const char *t = v.s; int tn = v.n; trim(&t, &tn); own_set(&scopes[scope], cwin[k].name, t, tn, 0); } else { own_set(&scopes[scope], cwin[k].name, NULL, 0, 1); }
		free(v.s);
	}
	/* declared values: substituted, pending shorthands expanded (JavaScript), trimmed */
	static Str *decl; static int declCap; if (declCap < ncprops) { declCap = ncprops; decl = realloc(decl, (size_t)declCap * sizeof(Str)); }
	static int *dlist; static int dcap; if (dcap < ncprops) { dcap = ncprops; dlist = realloc(dlist, (size_t)dcap * sizeof(int)); }
	int nd = 0, result = scope; double pfs = 16; JSValue color = JS_UNDEFINED;
	for (int k = 0; k < nwin; k++) {
		int p = winList[k]; Decl *d = win[p]; Str v;
		if (d->hasVar) { if (!substitute_cached(d->val.s, d->val.n, scope, &v)) { continue; } } else { v = str_dup(d->val.s, d->val.n); }
		if (d->pend) {
			uint32_t h; const double nocol[1] = { 0 }; PEnt *e = pcache_find(M_PENDING, d->pend - 1, p, v.s, v.n, 0, 0, nocol, 0, &h);
			if (!e) { JSValue r = call_parse(M_PENDING, d->pend - 1, p, v.s, v.n, 0, JS_UNDEFINED); if (JS_IsException(r)) { free(v.s); goto fail; } e = pcache_add(h, M_PENDING, d->pend - 1, p, v.s, v.n, 0, 0, nocol, 0); if (JS_IsString(r)) { size_t ln; const char *cs = JS_ToCStringLen(ctx, &ln, r); e->rs = str_dup(cs ? cs : "", cs ? (int)ln : 0); if (cs) { JS_FreeCString(ctx, cs); } } else { e->rnull = 1; } JS_FreeValue(ctx, r); statMisses++; } else { statHits++; }
			free(v.s); if (e->rnull) { continue; } v = str_dup(e->rs.s, e->rs.n);
		}
		const char *t = v.s; int tn = v.n; trim(&t, &tn); Str tv = str_dup(t, tn); free(v.s);
		decl[p] = tv; dlist[nd++] = p; declStamp[p] = callStamp;
	}
	/* font-size first (em units of the other properties depend on it), then color */
	if (hasParent) { JSValue x = JS_GetProperty(ctx, pvals, cprops[P_FONT_SIZE].atom); JS_ToFloat64(ctx, &pfs, x); JS_FreeValue(ctx, x); }
	double fontSize = pfs;
	if (declStamp[P_FONT_SIZE] == callStamp) {
		const Str *fs = &decl[P_FONT_SIZE];
		if (!ieq(fs->s, fs->n, "inherit") && !ieq(fs->s, fs->n, "unset")) {
			int done = 0;
			if (ieq(fs->s, fs->n, "initial")) { fontSize = 16; done = 1; }
			for (size_t q = 0; !done && q < sizeof kwFontSizes / sizeof kwFontSizes[0]; q++) { if (ieq(fs->s, fs->n, kwFontSizes[q].name)) { fontSize = kwFontSizes[q].px; done = 1; } }
			if (!done && fs->n == 7 && memcmp(fs->s, "smaller", 7) == 0) { fontSize = fontSize / 1.2; done = 1; }
			if (!done && fs->n == 6 && memcmp(fs->s, "larger", 6) == 0) { fontSize = fontSize * 1.2; done = 1; }
			if (!done) {
				uint32_t h; const double nocol[1] = { 0 }; PEnt *e = pcache_find(M_FONT_SIZE, 0, 0, fs->s, fs->n, 1, pfs, nocol, 0, &h);
				if (!e) { JSValue r = call_parse(M_FONT_SIZE, 0, 0, fs->s, fs->n, pfs, JS_UNDEFINED); if (JS_IsException(r)) { goto fail; } e = pcache_add(h, M_FONT_SIZE, 0, 0, fs->s, fs->n, 1, pfs, nocol, 0); e->v = r; statMisses++; } else { statHits++; }
				if (JS_IsNumber(e->v)) { JS_ToFloat64(ctx, &fontSize, e->v); }
			}
		}
	}
	color = hasParent ? JS_GetProperty(ctx, pvals, cprops[P_COLOR].atom) : JS_DupValue(ctx, colorInit);
	if (declStamp[P_COLOR] == callStamp) {
		const Str *c0 = &decl[P_COLOR];
		if (!ieq(c0->s, c0->n, "inherit") && !ieq(c0->s, c0->n, "unset")) {
			if (ieq(c0->s, c0->n, "initial")) { JS_FreeValue(ctx, color); color = JS_DupValue(ctx, colorInit); }
			else {
				double col[4] = { 0 }; int dep = icontains(c0->s, c0->n, "currentcolor") || icontains(c0->s, c0->n, "color-mix") || icontains(c0->s, c0->n, "light-dark"); int L = dep && JS_IsObject(color) ? read_color(color, col) : 0;
				uint32_t h; PEnt *e = pcache_find(M_COLOR, 0, 0, c0->s, c0->n, dep, 0, col, L, &h);
				if (!e) { JSValue r = call_parse(M_COLOR, 0, 0, c0->s, c0->n, 0, color); if (JS_IsException(r)) { goto fail; } e = pcache_add(h, M_COLOR, 0, 0, c0->s, c0->n, dep, 0, col, L); e->v = r; statMisses++; } else { statHits++; }
				if (!JS_IsNull(e->v) && !JS_IsUndefined(e->v)) { JS_FreeValue(ctx, color); color = JS_DupValue(ctx, e->v); }
			}
		}
	}
	double ccol[4] = { 0 }; int cL = JS_IsObject(color) ? read_color(color, ccol) : 0;
	/* every other declared property */
	for (int k = 0; k < nd; k++) {
		int p = dlist[k]; if (p == P_FONT_SIZE || p == P_COLOR) { continue; } const Str *dv = &decl[p]; const CProp *pr = &cprops[p]; JSValue v;
		if (dv->n > 6 && dv->s[0] == 'a' && (memcmp(dv->s, "anchor(", 7) == 0 || (dv->n > 11 && memcmp(dv->s, "anchor-size(", 12) == 0))) { result = -2; break; }   /* anchor positioning: JavaScript */
		if (ieq(dv->s, dv->n, "initial")) { v = JS_DupValue(ctx, pr->init); }
		else if (ieq(dv->s, dv->n, "inherit") || (pr->inh && ieq(dv->s, dv->n, "unset"))) { v = hasParent ? JS_GetProperty(ctx, pvals, pr->atom) : JS_DupValue(ctx, pr->init); }
		else if (ieq(dv->s, dv->n, "unset") || ieq(dv->s, dv->n, "revert") || ieq(dv->s, dv->n, "revert-layer")) { v = JS_DupValue(ctx, pr->init); }
		else {
			int dep = pr->isLen; static const char *deps[] = { "em", "ex", "ch", "vw", "vh", "vmin", "vmax", "calc", "min(", "max(", "clamp", "currentcolor", "color-mix" };
			for (size_t q = 0; !dep && q < sizeof deps / sizeof deps[0]; q++) { if (icontains(dv->s, dv->n, deps[q])) { dep = 1; } }
			uint32_t h; PEnt *e = pcache_find(M_VALUE, p, 0, dv->s, dv->n, dep, fontSize, ccol, dep ? cL : 0, &h);
			if (!e) { JSValue r = call_parse(M_VALUE, p, 0, dv->s, dv->n, fontSize, color); if (JS_IsException(r)) { goto fail; } e = pcache_add(h, M_VALUE, p, 0, dv->s, dv->n, dep, fontSize, ccol, dep ? cL : 0); e->v = r; statMisses++; } else { statHits++; }
			if (JS_IsNull(e->v) || JS_IsUndefined(e->v)) { v = pr->inh && hasParent ? JS_GetProperty(ctx, pvals, pr->atom) : JS_DupValue(ctx, pr->init); } else { v = JS_DupValue(ctx, e->v); }
		}
		if (JS_SetProperty(ctx, out, pr->atom, v) < 0) { goto fail; }
	}
	if (result != -2) { if (JS_SetProperty(ctx, out, cprops[P_FONT_SIZE].atom, JS_NewFloat64(ctx, fontSize)) < 0 || JS_SetProperty(ctx, out, cprops[P_COLOR].atom, JS_DupValue(ctx, color)) < 0) { goto fail; } }
	for (int k = 0; k < nd; k++) { free(decl[dlist[k]].s); }
	JS_FreeValue(ctx, color);
	if (result == -2) { statFallbacks++; if (owned) { scope_unref(scope); } return JS_NewInt32(ctx, -2); }
	return JS_NewInt32(ctx, result);
fail:
	for (int k = 0; k < nd; k++) { free(decl[dlist[k]].s); }
	JS_FreeValue(ctx, color); if (owned) { scope_unref(scope); } return JS_EXCEPTION;
}

/* ---------------------------------------------------------------- JS API */
/* computeInit(names, inherited Int32Array, isLength Int32Array, inits, colorInit, parseCb) */
static JSValue js_compute_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int32_t *inh, *isl; int n1, n2; if (get_i32(ctx, argv[1], &inh, &n1) || get_i32(ctx, argv[2], &isl, &n2) || n1 != n2) { return JS_ThrowTypeError(ctx, "computeInit: bad arguments"); }
	cctx = ctx; ncprops = n1; cprops = calloc((size_t)ncprops, sizeof(CProp)); A_length = JS_NewAtom(ctx, "length");
	for (int i = 0; i < ncprops; i++) {
		JSValue nm = JS_GetPropertyUint32(ctx, argv[0], (uint32_t)i); const char *s = JS_ToCString(ctx, nm); JS_FreeValue(ctx, nm); if (!s) { return JS_EXCEPTION; }
		cprops[i].atom = JS_NewAtom(ctx, s); cprops[i].inh = inh[i]; cprops[i].isLen = isl[i]; cprops[i].init = JS_GetPropertyUint32(ctx, argv[3], (uint32_t)i);
		if (strcmp(s, "font-size") == 0) { P_FONT_SIZE = i; } else if (strcmp(s, "color") == 0) { P_COLOR = i; }
		JS_FreeCString(ctx, s);
	}
	if (P_FONT_SIZE < 0 || P_COLOR < 0) { return JS_ThrowTypeError(ctx, "computeInit: font-size and color are required"); }
	colorInit = JS_DupValue(ctx, argv[4]); parseCb = JS_DupValue(ctx, argv[5]);
	win = calloc((size_t)ncprops, sizeof(Decl *)); winStamp = calloc((size_t)ncprops, sizeof(uint32_t)); declStamp = calloc((size_t)ncprops, sizeof(uint32_t)); winList = calloc((size_t)ncprops, sizeof(int));
	if (!nscopes) { int e = scope_new(-1); (void)e; }   /* scope 0: the empty root scope, never freed */
	return JS_UNDEFINED;
}
/* declBlock(fields: Int32Array [pidx, customAtom, important, pending+1] per declaration, values: string[]) -> block id */
static JSValue js_decl_block(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int32_t *f; int fn; if (get_i32(ctx, argv[0], &f, &fn) || fn % 4) { return JS_ThrowTypeError(ctx, "declBlock: bad arguments"); }
	int id; if (freeBlocks.n) { id = freeBlocks.v[--freeBlocks.n]; } else { if (nblocks == capblocks) { capblocks = capblocks ? capblocks * 2 : 4096; blocks = realloc(blocks, (size_t)capblocks * sizeof(Block)); } id = nblocks++; }
	Block *b = &blocks[id]; memset(b, 0, sizeof *b); b->used = 1; b->n = fn / 4; b->d = calloc((size_t)(b->n ? b->n : 1), sizeof(Decl));
	for (int i = 0; i < b->n; i++) {
		Decl *d = &b->d[i]; d->pidx = f[4 * i]; d->custom = f[4 * i + 1]; d->imp = f[4 * i + 2]; d->pend = f[4 * i + 3];
		if (d->pidx >= ncprops || d->custom >= natoms) { free_block(b); vpush(&freeBlocks, id); return JS_ThrowRangeError(ctx, "declBlock: bad property"); }
		JSValue v = JS_GetPropertyUint32(ctx, argv[1], (uint32_t)i); size_t ln; const char *s = JS_ToCStringLen(ctx, &ln, v); JS_FreeValue(ctx, v);
		d->val = str_dup(s ? s : "", s ? (int)ln : 0); if (s) { JS_FreeCString(ctx, s); } d->hasVar = contains(d->val.s, d->val.n, "var(");
	}
	return JS_NewInt32(ctx, id);
}
static JSValue js_decl_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int32_t id; if (JS_ToInt32(ctx, &id, argv[0]) || id < 0 || id >= nblocks || !blocks[id].used) { return JS_UNDEFINED; } free_block(&blocks[id]); vpush(&freeBlocks, id); return JS_UNDEFINED; }
static JSValue js_scope_unref(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int32_t id; if (!JS_ToInt32(ctx, &id, argv[0])) { scope_unref(id); } return JS_UNDEFINED; }
static int scope_arg(JSContext *ctx, JSValueConst v) { int32_t id; if (JS_ToInt32(ctx, &id, v) || id < 0 || id >= nscopes || !scopes[id].used) { return -1; } return id; }
static JSValue js_var_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int id = scope_arg(ctx, argv[0]); if (id < 0) { return JS_ThrowRangeError(ctx, "varGet: bad scope"); }
	size_t ln; const char *s = JS_ToCStringLen(ctx, &ln, argv[1]); if (!s) { return JS_EXCEPTION; } int nm = atom_find(s, (int)ln); JS_FreeCString(ctx, s);
	const Str *v = nm >= 0 ? scope_get(id, nm) : NULL; return v ? JS_NewStringLen(ctx, v->s, (size_t)v->n) : JS_UNDEFINED;
}
/* varEntries(scope) -> [name, value, ...] of every defined custom property */
static JSValue js_var_entries(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int id = scope_arg(ctx, argv[0]); if (id < 0) { return JS_ThrowRangeError(ctx, "varEntries: bad scope"); }
	Vec names = { 0 }, idx = { 0 }; scope_collect(id, &names, &idx); JSValue a = JS_NewArray(ctx);
	for (int k = 0; k < names.n; k++) { const Str *v = &scopes[idx.v[2 * k]].own[idx.v[2 * k + 1]].val; JS_SetPropertyUint32(ctx, a, (uint32_t)(2 * k), JS_NewStringLen(ctx, atoms[names.v[k]].s, (size_t)atoms[names.v[k]].len)); JS_SetPropertyUint32(ctx, a, (uint32_t)(2 * k + 1), JS_NewStringLen(ctx, v->s, (size_t)v->n)); }
	free(names.v); free(idx.v); return a;
}
static JSValue js_vars_equal(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int a = scope_arg(ctx, argv[0]), b = scope_arg(ctx, argv[1]); if (a < 0 || b < 0) { return JS_ThrowRangeError(ctx, "varsEqual: bad scope"); } return JS_NewBool(ctx, scope_equal(a, b)); }
/* scopeFrom(names atoms Int32Array, values string[]) -> a flat scope with these entries (for a JavaScript VarScope parent) */
static JSValue js_scope_from(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int32_t *nm; int n; if (get_i32(ctx, argv[0], &nm, &n)) { return JS_ThrowTypeError(ctx, "scopeFrom: bad arguments"); }
	int id = scope_new(-1);
	for (int i = 0; i < n; i++) { if (nm[i] < 0 || nm[i] >= natoms) { continue; } JSValue v = JS_GetPropertyUint32(ctx, argv[1], (uint32_t)i); size_t ln; const char *s = JS_ToCStringLen(ctx, &ln, v); JS_FreeValue(ctx, v); if (s) { own_set(&scopes[id], nm[i], s, (int)ln, 0); JS_FreeCString(ctx, s); } }
	return JS_NewInt32(ctx, id);
}
static JSValue js_compute_stats(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValue r = JS_NewObject(ctx); int live = 0; for (int i = 0; i < nscopes; i++) { live += scopes[i].used; } int lb = 0; for (int i = 0; i < nblocks; i++) { lb += blocks[i].used; }
	JS_SetPropertyStr(ctx, r, "computes", JS_NewFloat64(ctx, (double)statComputes)); JS_SetPropertyStr(ctx, r, "fallbacks", JS_NewFloat64(ctx, (double)statFallbacks)); JS_SetPropertyStr(ctx, r, "cacheHits", JS_NewFloat64(ctx, (double)statHits)); JS_SetPropertyStr(ctx, r, "cacheMisses", JS_NewFloat64(ctx, (double)statMisses));
	JS_SetPropertyStr(ctx, r, "cacheSize", JS_NewInt32(ctx, (int)pcount)); JS_SetPropertyStr(ctx, r, "scopes", JS_NewInt32(ctx, live)); JS_SetPropertyStr(ctx, r, "blocks", JS_NewInt32(ctx, lb)); return r;
}
#define STYLE_COMPUTE_FUNCS \
	JS_CFUNC_DEF("computeInit", 6, js_compute_init), JS_CFUNC_DEF("declBlock", 2, js_decl_block), JS_CFUNC_DEF("declFree", 1, js_decl_free), JS_CFUNC_DEF("compute", 9, js_compute), \
	JS_CFUNC_DEF("scopeUnref", 1, js_scope_unref), JS_CFUNC_DEF("varGet", 2, js_var_get), JS_CFUNC_DEF("varEntries", 1, js_var_entries), JS_CFUNC_DEF("varsEqual", 2, js_vars_equal), \
	JS_CFUNC_DEF("scopeFrom", 2, js_scope_from), JS_CFUNC_DEF("computeStats", 0, js_compute_stats),
