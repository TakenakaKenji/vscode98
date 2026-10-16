/* spike:style - selector text -> the parsed selector objects of selectors.js parseSelector (included by style.c).
 *
 * Exactly selectors.js parseList/parseComplex/parseCompound/parseNth for the selectors VS Code's stylesheets use: ASCII text without backslash escapes, :nth-*() without
 * `of S`. Anything else returns null and selectors.js parses it itself (also every case where the JavaScript parser throws).
 * Two savings over the JavaScript parser, which is ~0.45 s of the first style pass at startup:
 *  - compounds are shared: the ~60,000 compounds of the workbench's 13,000 rules are ~11,000 distinct texts (`.monaco-workbench`, `.part > .content` ...); a compound's
 *    text is parsed dry first (extent, specificity), and an identical text returns the same object (nothing writes to a parsed compound but the parser);
 *  - every top-level complex selector gets its native serialized form (native_style.js serComplex, read by style.c read_sel) as `__nser`, so the native index entry
 *    needs no second walk in JavaScript. */

typedef struct { int32_t *v; int n, cap; } IBuf;
static void ib_push(IBuf *b, int32_t x) { if (b->n == b->cap) { b->cap = b->cap ? b->cap * 2 : 32; b->v = realloc(b->v, (size_t)b->cap * sizeof(int32_t)); } b->v[b->n++] = x; }
static void ib_cat(IBuf *b, const int32_t *v, int n) { for (int i = 0; i < n; i++) { ib_push(b, v[i]); } }

typedef struct { const char *s; int n, i, fail; JSContext *ctx; } SP;
static JSAtom sa_tag, sa_id, sa_classes, sa_attrs, sa_pseudos, sa_pe, sa_spec, sa_parts, sa_comb, sa_compound, sa_name, sa_arg, sa_op, sa_value, sa_flag, sa_a, sa_b, sa_of, sa_nser;

/* shared compounds: source text -> object, specificity, serialized form */
typedef struct { char *key; int klen; uint32_t h; JSValue obj; int spec[3]; int32_t *ser; int nser; } CEnt;
static CEnt *ctab; static int ccap, ccount;
static uint32_t sel_hash(const char *s, int n) { uint32_t h = 2166136261u; for (int i = 0; i < n; i++) { h = (h ^ (uint8_t)s[i]) * 16777619u; } return h ? h : 1; }
static CEnt *cent_find(const char *s, int n, uint32_t h) {
	if (!ccap) { return NULL; }
	for (int k = (int)(h & (uint32_t)(ccap - 1));; k = (k + 1) & (ccap - 1)) { CEnt *e = &ctab[k]; if (!e->h) { return NULL; } if (e->h == h && e->klen == n && memcmp(e->key, s, (size_t)n) == 0) { return e; } }
}
static void cent_clear(JSContext *ctx) { for (int k = 0; k < ccap; k++) { if (ctab[k].h) { free(ctab[k].key); free(ctab[k].ser); JS_FreeValue(ctx, ctab[k].obj); } } free(ctab); ctab = NULL; ccap = ccount = 0; }
static CEnt *cent_add(JSContext *ctx, const char *s, int n, uint32_t h) {
	if (ccount > 100000) { cent_clear(ctx); }   /* bounded: selectors from generated stylesheets keep coming */
	if ((ccount + 1) * 2 > ccap) {
		int nc = ccap ? ccap * 2 : 4096; CEnt *nt = calloc((size_t)nc, sizeof(CEnt));
		for (int k = 0; k < ccap; k++) { if (ctab[k].h) { int j = (int)(ctab[k].h & (uint32_t)(nc - 1)); while (nt[j].h) { j = (j + 1) & (nc - 1); } nt[j] = ctab[k]; } }
		free(ctab); ctab = nt; ccap = nc;
	}
	int j = (int)(h & (uint32_t)(ccap - 1)); while (ctab[j].h) { j = (j + 1) & (ccap - 1); }
	CEnt *e = &ctab[j]; e->key = malloc((size_t)n + 1); memcpy(e->key, s, (size_t)n); e->klen = n; e->h = h; ccount++; return e;
}

static inline int sp_peek(SP *p) { return p->i < p->n ? (uint8_t)p->s[p->i] : -1; }
static int sp_ws(SP *p) { int st = p->i; while (p->i < p->n) { int c = (uint8_t)p->s[p->i]; if (c == 32 || c == 9 || c == 10 || c == 13 || c == 12 || c == 11) { p->i++; } else { break; } } return p->i > st; }
static inline int sp_identc(int c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-'; }
static int sp_ident(SP *p) { int st = p->i; while (p->i < p->n && sp_identc((uint8_t)p->s[p->i])) { p->i++; } return st; }   /* returns the start; the identifier is [start, p->i) */
static JSValue sp_str(SP *p, int a, int len, int lower) {
	if (!lower) { return JS_NewStringLen(p->ctx, p->s + a, (size_t)len); }
	char buf[256]; char *t = len <= (int)sizeof buf ? buf : malloc((size_t)len); for (int k = 0; k < len; k++) { t[k] = (char)lc((uint8_t)p->s[a + k]); }
	JSValue v = JS_NewStringLen(p->ctx, t, (size_t)len); if (t != buf) { free(t); } return v;
}
static int sp_atom(SP *p, int a, int len, int lower) {
	if (!lower) { return intern(p->s + a, len); }
	char buf[256]; char *t = len <= (int)sizeof buf ? buf : malloc((size_t)len); for (int k = 0; k < len; k++) { t[k] = (char)lc((uint8_t)p->s[a + k]); }
	int r = intern(t, len); if (t != buf) { free(t); } return r;
}
static int sp_is(SP *p, int a, int len, const char *lit) { int m = (int)strlen(lit); if (len != m) { return 0; } for (int k = 0; k < m; k++) { if (lc((uint8_t)p->s[a + k]) != lit[k]) { return 0; } } return 1; }
static const char *const PSEUDO_ELEMENTS[] = { "before", "after", "first-line", "first-letter", "selection", "placeholder", "marker", "backdrop", "-webkit-scrollbar", "-webkit-scrollbar-thumb", "-webkit-scrollbar-track", "-webkit-scrollbar-corner", "-webkit-input-placeholder", "-moz-placeholder", "cue", "file-selector-button", "-webkit-file-upload-button", "part", "slotted", "highlight", NULL };
static const char *const LIST_PSEUDOS[] = { "not", "is", "where", "matches", "has", "-webkit-any", "any", NULL };
static const struct { const char *name; int code; } PSEUDO_CODES[] = {   /* native_style.js PSEUDO */
	{ "root", 2 }, { "first-child", 3 }, { "last-child", 4 }, { "only-child", 5 }, { "first-of-type", 6 }, { "last-of-type", 7 }, { "only-of-type", 8 }, { "nth-child", 9 }, { "nth-last-child", 10 }, { "nth-of-type", 11 }, { "nth-last-of-type", 12 },
	{ "empty", 13 }, { "not", 14 }, { "is", 15 }, { "where", 15 }, { "matches", 15 }, { "-webkit-any", 15 }, { "any", 15 }, { "has", 16 }, { "hover", 17 }, { "active", 18 }, { "focus", 19 }, { "focus-visible", 20 }, { "focus-within", 21 },
	{ "checked", 22 }, { "disabled", 23 }, { "enabled", 24 }, { "link", 25 }, { "any-link", 25 }, { "read-only", 26 }, { "read-write", 27 }, { "required", 28 }, { "optional", 29 }, { "dir", 1 }, { "lang", 1 }, { "host", 1 }, { "host-context", 1 }, { "defined", 1 }, { NULL, 0 } };
static int in_list(SP *p, int a, int len, const char *const *l) { for (; *l; l++) { if (sp_is(p, a, len, *l)) { return 1; } } return 0; }
static int pseudo_code(SP *p, int a, int len) { for (int k = 0; PSEUDO_CODES[k].name; k++) { if (sp_is(p, a, len, PSEUDO_CODES[k].name)) { return PSEUDO_CODES[k].code; } } return 0; }
static int cmp_spec(const int *a, const int *b) { return a[0] != b[0] ? a[0] - b[0] : a[1] != b[1] ? a[1] - b[1] : a[2] - b[2]; }
static JSValue spec_arr(JSContext *ctx, const int *sp) { JSValue a = JS_NewArray(ctx); for (int k = 0; k < 3; k++) { JS_SetPropertyUint32(ctx, a, (uint32_t)k, JS_NewInt32(ctx, sp[k])); } return a; }
static int32_t clamp_i(double d) { return d > 1e9 ? 1000000000 : d < -1e9 ? -1000000000 : (int32_t)d; }

static void sel_list(SP *p, int build, JSValue *arr, IBuf *ser, int top);
static void sel_list_dry(SP *p, int maxSpec[3]);
/* JavaScript parseInt(s, 10) of an ASCII string without white space; *ok = 0 for what this does not reproduce exactly (very long numbers) */
static double js_parse_int(const char *s, int n, int *ok) {
	int k = 0, neg = 0; if (k < n && (s[k] == '+' || s[k] == '-')) { neg = s[k] == '-'; k++; }
	int d0 = k; double v = 0; while (k < n && s[k] >= '0' && s[k] <= '9') { v = v * 10 + (s[k] - '0'); k++; }
	if (k == d0) { return NAN; } if (k - d0 > 15) { *ok = 0; } return neg ? -v : v;
}
/* parseNth: the text up to the top-level ')' -> a, b; fails for `of S` */
static void sel_nth(SP *p, double *a, double *b) {
	int st = p->i, depth = 0; while (p->i < p->n) { int c = (uint8_t)p->s[p->i]; if (c == ')' && depth == 0) { break; } if (c == '(') { depth++; } if (c == ')') { depth--; } p->i++; }
	char t[64]; int tn = 0;
	for (int k = st; k < p->i; k++) {
		int c = (uint8_t)p->s[k]; if (c == '\n' || c == '\r') { p->fail = 1; return; }
		if (c == 32 || c == 9 || c == 12 || c == 11) { continue; } if (tn >= (int)sizeof t) { p->fail = 1; return; } t[tn++] = (char)lc(c);
	}
	for (int k = 0; k + 1 < tn; k++) { if (t[k] == 'o' && t[k + 1] == 'f') { p->fail = 1; return; } }   /* maybe `of S`: the JavaScript parser */
	int ok = 1;
	if (tn == 3 && memcmp(t, "odd", 3) == 0) { *a = 2; *b = 1; return; } if (tn == 4 && memcmp(t, "even", 4) == 0) { *a = 2; *b = 0; return; }
	/* /^([+-]?\d*)n([+-]\d+)?$/ */
	int k = 0; if (k < tn && (t[k] == '+' || t[k] == '-')) { k++; } while (k < tn && t[k] >= '0' && t[k] <= '9') { k++; }
	if (k < tn && t[k] == 'n') {
		int nk = k, j = k + 1, rest = 1;
		if (j < tn) { if (t[j] == '+' || t[j] == '-') { int d = j + 1; while (d < tn && t[d] >= '0' && t[d] <= '9') { d++; } rest = d == tn && d > j + 1; } else { rest = 0; } }
		if (rest) {
			if (nk == 0 || (nk == 1 && t[0] == '+')) { *a = 1; } else if (nk == 1 && t[0] == '-') { *a = -1; } else { *a = js_parse_int(t, nk, &ok); }
			*b = j < tn ? js_parse_int(t + j, tn - j, &ok) : 0; if (!ok) { p->fail = 1; } return;
		}
	}
	*a = 0; *b = js_parse_int(t, tn, &ok); if (!ok) { p->fail = 1; }
}
typedef struct { int a, len; } Sl;
/* parseCompound. Dry (build = 0): only the extent and the specificity. Build: the object (shared by text) and its serialized form. */
static void sel_compound(SP *p, int build, JSValue *out, IBuf *ser, int spec[3]) {
	int start = p->i; spec[0] = spec[1] = spec[2] = 0; int any = 0;
	if (build) {   /* the same text was parsed before: the same object */
		SP d = *p; int ds[3]; sel_compound(&d, 0, NULL, NULL, ds); if (d.fail) { p->fail = 1; return; }
		uint32_t h = sel_hash(p->s + start, d.i - start); CEnt *e = cent_find(p->s + start, d.i - start, h);
		if (e) { *out = JS_DupValue(p->ctx, e->obj); ib_cat(ser, e->ser, e->nser); memcpy(spec, e->spec, sizeof e->spec); p->i = d.i; return; }
	}
	JSContext *ctx = p->ctx; JSValue classes = JS_UNDEFINED, attrs = JS_UNDEFINED, pseudos = JS_UNDEFINED; uint32_t ncl = 0, nat = 0, nps = 0;
	IBuf cls = { 0 }, ats = { 0 }, pss = { 0 }; int tagAtom = -1, idAtom = -1; JSValue tag = JS_NULL, id = JS_NULL, pe = JS_NULL;
	if (build) { classes = JS_NewArray(ctx); attrs = JS_NewArray(ctx); pseudos = JS_NewArray(ctx); }
	if (sp_peek(p) == '*') { p->i++; any = 1; if (sp_peek(p) == '|') { p->i++; } }
	else if (p->i < p->n && sp_identc(sp_peek(p))) { int a = sp_ident(p); if (build) { tag = sp_str(p, a, p->i - a, 1); tagAtom = sp_atom(p, a, p->i - a, 1); } any = 1; spec[2]++; }
	while (!p->fail) {
		int ch = sp_peek(p);
		if (ch == '#') { p->i++; int a = sp_ident(p); if (build) { JS_FreeValue(ctx, id); id = sp_str(p, a, p->i - a, 0); idAtom = sp_atom(p, a, p->i - a, 0); } spec[0]++; any = 1; }
		else if (ch == '.') { p->i++; int a = sp_ident(p); if (build) { JS_SetPropertyUint32(ctx, classes, ncl++, sp_str(p, a, p->i - a, 0)); ib_push(&cls, sp_atom(p, a, p->i - a, 0)); } spec[1]++; any = 1; }
		else if (ch == '[') {
			p->i++; sp_ws(p); int na = sp_ident(p), nl = p->i - na; sp_ws(p); int hasOp = 0, oa = 0, ol = 0, va = 0, vl = 0, fl = -1;
			if (sp_peek(p) != ']') {
				if (p->i >= p->n) { p->fail = 1; break; }   /* the JavaScript parser throws here */
				hasOp = 1; oa = p->i; while (p->i < p->n && strchr("~|^$*=", p->s[p->i])) { p->i++; } ol = p->i - oa; sp_ws(p);
				int q = sp_peek(p);
				if (q == '"' || q == '\'') { p->i++; va = p->i; while (p->i < p->n && (uint8_t)p->s[p->i] != q) { p->i++; } if (p->i >= p->n) { p->fail = 1; break; } vl = p->i - va; p->i++; }
				else { va = sp_ident(p); vl = p->i - va; }
				sp_ws(p); if (p->i >= p->n) { p->fail = 1; break; }
				int f = sp_peek(p); if (f == 'i' || f == 'I' || f == 's' || f == 'S') { fl = lc(f); p->i++; sp_ws(p); }
			}
			p->i++;
			if (build) {
				JSValue o = JS_NewObject(ctx); JS_DefinePropertyValue(ctx, o, sa_name, sp_str(p, na, nl, 1), JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, o, sa_op, hasOp ? sp_str(p, oa, ol, 0) : JS_NULL, JS_PROP_C_W_E);
				JS_DefinePropertyValue(ctx, o, sa_value, sp_str(p, va, vl, 0), JS_PROP_C_W_E); char fc = (char)fl; JS_DefinePropertyValue(ctx, o, sa_flag, JS_NewStringLen(ctx, &fc, fl >= 0 ? 1 : 0), JS_PROP_C_W_E);
				JS_SetPropertyUint32(ctx, attrs, nat++, o);
				int opc = 0; if (hasOp && ol > 0) { opc = 7; static const char *const ops[] = { "=", "~=", "|=", "^=", "$=", "*=" }; for (int k = 0; k < 6; k++) { if ((int)strlen(ops[k]) == ol && memcmp(ops[k], p->s + oa, (size_t)ol) == 0) { opc = k + 1; } } }
				ib_push(&ats, sp_atom(p, na, nl, 1)); ib_push(&ats, opc); ib_push(&ats, sp_atom(p, va, vl, 0)); ib_push(&ats, fl == 'i' ? 1 : 0);
			}
			spec[1]++; any = 1;
		}
		else if (ch == ':') {
			p->i++; int isPe = 0; if (sp_peek(p) == ':') { p->i++; isPe = 1; }
			int na = sp_ident(p), nl = p->i - na; int kind = 0;   /* 0 no argument, 1 list, 2 nth, 3 text */
			JSValue arg = JS_NULL; IBuf argSer = { 0 }; int argSpec[3] = { 0, 0, 0 }; double na_ = 0, nb_ = 0; int ta = 0, tl = 0;
			if (sp_peek(p) == '(') {
				p->i++; sp_ws(p);
				if (in_list(p, na, nl, LIST_PSEUDOS)) {
					kind = 1; SP d = *p; sel_list_dry(&d, argSpec); if (d.fail) { p->fail = 1; break; }   /* the list's highest specificity */
					if (build) { sel_list(p, 1, &arg, &argSer, 0); } else { *p = d; }
				}
				else if (nl >= 4 && sp_is(p, na, 4, "nth-")) { kind = 2; sel_nth(p, &na_, &nb_); }
				else {
					kind = 3; int depth = 1, st = p->i; while (p->i < p->n && depth) { int x = (uint8_t)p->s[p->i++]; if (x == '(') { depth++; } else if (x == ')') { depth--; if (!depth) { break; } } }
					if (depth) { p->fail = 1; break; }   /* unterminated: the JavaScript parser's position arithmetic differs there */
					ta = st; tl = p->i - 1 - st; { const char *t = p->s + ta; trim(&t, &tl); ta = (int)(t - p->s); } p->i--;
				}
				if (p->fail) { JS_FreeValue(ctx, arg); free(argSer.v); break; }
				sp_ws(p); if (sp_peek(p) == ')') { p->i++; }
			}
			if (isPe || in_list(p, na, nl, PSEUDO_ELEMENTS)) { if (build) { JS_FreeValue(ctx, pe); pe = sp_str(p, na, nl, 1); } spec[2]++; JS_FreeValue(ctx, arg); }
			else {
				int lowerName = 1;
				if (build) {
					JSValue o = JS_NewObject(ctx); JS_DefinePropertyValue(ctx, o, sa_name, sp_str(p, na, nl, lowerName), JS_PROP_C_W_E);
					if (kind == 2) { JSValue nth = JS_NewObject(ctx); JS_DefinePropertyValue(ctx, nth, sa_a, JS_NewFloat64(ctx, na_), JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, nth, sa_b, JS_NewFloat64(ctx, nb_), JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, nth, sa_of, JS_NULL, JS_PROP_C_W_E); arg = nth; }
					else if (kind == 3) { arg = sp_str(p, ta, tl, 0); }
					JS_DefinePropertyValue(ctx, o, sa_arg, arg, JS_PROP_C_W_E); JS_SetPropertyUint32(ctx, pseudos, nps++, o);
					int code = pseudo_code(p, na, nl);
					if (code >= 9 && code <= 12 && !(kind == 2 && isfinite(na_) && isfinite(nb_))) { code = 0; }
					ib_push(&pss, code);
					if (code == 14 || code == 15 || code == 16) { if (kind == 1) { ib_cat(&pss, argSer.v, argSer.n); } else { ib_push(&pss, 0); } }
					else if (code == 9 || code == 10) { ib_push(&pss, clamp_i(na_)); ib_push(&pss, clamp_i(nb_)); ib_push(&pss, -1); }
					else if (code == 11 || code == 12) { ib_push(&pss, clamp_i(na_)); ib_push(&pss, clamp_i(nb_)); }
				}
				if (sp_is(p, na, nl, "where")) { } else if (in_list(p, na, nl, LIST_PSEUDOS)) { if (kind == 1) { spec[0] += argSpec[0]; spec[1] += argSpec[1]; spec[2] += argSpec[2]; } else { p->fail = 1; } }   /* a list pseudo without (): the JavaScript parser throws */
				else { spec[1]++; }
			}
			free(argSer.v); any = 1;
		}
		else { break; }
	}
	if (!any) { p->fail = 1; }
	if (!build) { return; }
	if (p->fail) { JS_FreeValue(ctx, classes); JS_FreeValue(ctx, attrs); JS_FreeValue(ctx, pseudos); JS_FreeValue(ctx, tag); JS_FreeValue(ctx, id); JS_FreeValue(ctx, pe); free(cls.v); free(ats.v); free(pss.v); return; }
	JSValue c = JS_NewObject(ctx);
	JS_DefinePropertyValue(ctx, c, sa_tag, tag, JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, c, sa_id, id, JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, c, sa_classes, classes, JS_PROP_C_W_E);
	JS_DefinePropertyValue(ctx, c, sa_attrs, attrs, JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, c, sa_pseudos, pseudos, JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, c, sa_pe, pe, JS_PROP_C_W_E);
	JS_DefinePropertyValue(ctx, c, sa_spec, spec_arr(ctx, spec), JS_PROP_C_W_E);
	IBuf me = { 0 }; ib_push(&me, tagAtom); ib_push(&me, idAtom); ib_push(&me, (int32_t)ncl); ib_cat(&me, cls.v, cls.n); ib_push(&me, (int32_t)nat); ib_cat(&me, ats.v, ats.n); ib_push(&me, (int32_t)nps); ib_cat(&me, pss.v, pss.n);
	free(cls.v); free(ats.v); free(pss.v);
	uint32_t h = sel_hash(p->s + start, p->i - start); CEnt *e = cent_add(ctx, p->s + start, p->i - start, h);
	e->obj = JS_DupValue(ctx, c); memcpy(e->spec, spec, sizeof e->spec); e->ser = me.v; e->nser = me.n;
	ib_cat(ser, me.v, me.n); *out = c;
}
/* parseComplex (always built: complexes are not shared) */
static JSValue sel_complex(SP *p, IBuf *ser, int top) {
	JSContext *ctx = p->ctx; JSValue parts = JS_NewArray(ctx); uint32_t np = 0; int spec[3] = { 0, 0, 0 }; int comb = ' ';
	IBuf body = { 0 };
	for (;;) {
		JSValue c = JS_UNDEFINED; int cs[3]; IBuf cser = { 0 }; sel_compound(p, 1, &c, &cser, cs); if (p->fail) { free(cser.v); break; }
		JSValue part = JS_NewObject(ctx); char cb = (char)comb; JS_DefinePropertyValue(ctx, part, sa_comb, JS_NewStringLen(ctx, &cb, 1), JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, part, sa_compound, c, JS_PROP_C_W_E);
		JS_SetPropertyUint32(ctx, parts, np++, part); spec[0] += cs[0]; spec[1] += cs[1]; spec[2] += cs[2];
		ib_push(&body, comb == ' ' ? 0 : comb == '>' ? 1 : comb == '+' ? 2 : 3); ib_cat(&body, cser.v, cser.n); free(cser.v);
		int had = sp_ws(p); int ch = sp_peek(p);
		if (ch == '>' || ch == '+' || ch == '~') { comb = ch; p->i++; sp_ws(p); continue; }
		if (ch == -1 || ch == ',' || ch == ')') { break; }
		if (had) { comb = ' '; continue; }
		break;
	}
	if (p->fail) { JS_FreeValue(ctx, parts); free(body.v); return JS_UNDEFINED; }
	JSValue cx = JS_NewObject(ctx); JS_DefinePropertyValue(ctx, cx, sa_parts, parts, JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, cx, sa_spec, spec_arr(ctx, spec), JS_PROP_C_W_E);
	ib_push(ser, (int32_t)np); ib_cat(ser, body.v, body.n);
	if (top) {   /* native_style.js serialized(): [nparts, then per part comb and the compound] */
		int32_t *w = malloc((size_t)(body.n + 1) * sizeof(int32_t)); w[0] = (int32_t)np; if (body.n) { memcpy(w + 1, body.v, (size_t)body.n * sizeof(int32_t)); }
		JSValue ab = JS_NewArrayBufferCopy(ctx, (const uint8_t *)w, (size_t)(body.n + 1) * sizeof(int32_t)); free(w);
		JSValue ta = JS_NewTypedArray(ctx, 1, &ab, JS_TYPED_ARRAY_INT32); JS_FreeValue(ctx, ab); JS_DefinePropertyValue(ctx, cx, sa_nser, ta, JS_PROP_C_W_E);
	}
	free(body.v); return cx;
}
/* parseList, dry: the extent and the highest specificity of its complex selectors (selectors.js cmpSpec) */
static void sel_list_dry(SP *p, int maxSpec[3]) {
	maxSpec[0] = maxSpec[1] = maxSpec[2] = 0; sp_ws(p);
	for (;;) {
		int cs[3] = { 0, 0, 0 };
		for (;;) {
			int s3[3]; sel_compound(p, 0, NULL, NULL, s3); if (p->fail) { return; } cs[0] += s3[0]; cs[1] += s3[1]; cs[2] += s3[2];
			int had = sp_ws(p); int c = sp_peek(p); if (c == '>' || c == '+' || c == '~') { p->i++; sp_ws(p); continue; } if (c == -1 || c == ',' || c == ')') { break; } if (had) { continue; } break;
		}
		if (cmp_spec(cs, maxSpec) > 0) { memcpy(maxSpec, cs, sizeof cs); }
		sp_ws(p); if (sp_peek(p) == ',') { p->i++; sp_ws(p); continue; } break;
	}
}
/* parseList; ser gets [count, complexes...] */
static void sel_list(SP *p, int build, JSValue *arr, IBuf *ser, int top) {
	if (!build) { int m[3]; sel_list_dry(p, m); return; }
	JSValue list = JS_NewArray(p->ctx); uint32_t n = 0; IBuf items = { 0 }; sp_ws(p);
	for (;;) { JSValue cx = sel_complex(p, &items, top); if (p->fail) { break; } JS_SetPropertyUint32(p->ctx, list, n++, cx); sp_ws(p); if (sp_peek(p) == ',') { p->i++; sp_ws(p); continue; } break; }
	if (p->fail) { JS_FreeValue(p->ctx, list); free(items.v); *arr = JS_UNDEFINED; return; }
	ib_push(ser, (int32_t)n); ib_cat(ser, items.v, items.n); free(items.v); *arr = list;
}
/* parseSelector(text) -> the list of complex selectors (top-level ones with __nser), or null */
static JSValue js_parse_selector(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	if (!sa_tag) {
#define A(v, s) v = JS_NewAtom(ctx, s)
		A(sa_tag, "tag"); A(sa_id, "id"); A(sa_classes, "classes"); A(sa_attrs, "attrs"); A(sa_pseudos, "pseudos"); A(sa_pe, "pseudoElement"); A(sa_spec, "spec"); A(sa_parts, "parts"); A(sa_comb, "comb"); A(sa_compound, "compound");
		A(sa_name, "name"); A(sa_arg, "arg"); A(sa_op, "op"); A(sa_value, "value"); A(sa_flag, "flag"); A(sa_a, "a"); A(sa_b, "b"); A(sa_of, "of"); A(sa_nser, "__nser");
#undef A
	}
	size_t len; const char *s = JS_ToCStringLen(ctx, &len, argv[0]); if (!s) { return JS_EXCEPTION; }
	for (size_t i = 0; i < len; i++) { unsigned c = (uint8_t)s[i]; if (c >= 0x80 || c == '\\' || c == 0) { JS_FreeCString(ctx, s); return JS_NULL; } }   /* escapes, non-ASCII: the JavaScript parser */
	SP p = { s, (int)len, 0, 0, ctx }; JSValue list = JS_UNDEFINED; IBuf ser = { 0 };
	sel_list(&p, 1, &list, &ser, 1); free(ser.v); JS_FreeCString(ctx, s);
	if (p.fail) { JS_FreeValue(ctx, list); return JS_NULL; }
	return list;
}
#define STYLE_SELECTOR_FUNCS JS_CFUNC_DEF("parseSelector", 1, js_parse_selector),
