/* spike:style - stylesheet text -> rules (included by style.c). Exactly css.js parseRules / parseStyleRule / parseDeclarations (comment stripping, the quote/paren/brace scanning of
 * readPrelude/readBlock/splitDecls, JavaScript trim, `!important`, lower-cased names), so that the 2 MB workbench stylesheet is parsed in milliseconds instead of ~0.6 s.
 * The result is a nested array that css.js turns into CSSStyleRule/CSSGroupRule objects (the declaration objects are made here):
 *   [selectorText, decls]            a style rule            [null, selectorText, body]   a style rule with nested rules (css.js parseStyleRule does those)
 *   [4|12|0, prelude, items]         @media/@supports/other grouping rule                [5, prelude, decls]   @font-face
 * Anything this does not handle exactly like the JavaScript parser (an at-rule without a name, a non-ASCII property name, lone surrogates) returns null: css.js then parses the
 * whole text itself. */

static int sheet_fail;
static JSAtom at_name, at_value, at_important;

/* css.js stripComments: /\/\*[\s\S]*?\*\//g removed; an unterminated comment stays */
static char *sheet_strip(const char *t, int n, int *on) {
	char *o = malloc((size_t)n + 1); int k = 0, i = 0;
	while (i < n) {
		if (t[i] == '/' && i + 1 < n && t[i + 1] == '*') {
			int j = i + 2; while (j + 1 < n && !(t[j] == '*' && t[j + 1] == '/')) { j++; }
			if (j + 1 < n) { i = j + 2; continue; }
			memcpy(o + k, t + i, (size_t)(n - i)); k += n - i; break;
		}
		o[k++] = t[i++];
	}
	o[k] = 0; *on = k; return o;
}
/* css.js readBlock: t[i] is '{'; the index after the matching '}' (or n) */
static int sheet_block(const char *t, int n, int i) {
	int d = 0, q = 0;
	for (; i < n; i++) {
		int c = (uint8_t)t[i];
		if (q) { if (c == '\\') { i++; } else if (c == q) { q = 0; } continue; }
		if (c == '"' || c == '\'') { q = c; } else if (c == '{') { d++; } else if (c == '}') { d--; if (d == 0) { return i + 1; } }
	}
	return n;
}
/* css.js readPrelude: the index of the first '{' or ';' outside quotes and parentheses (or n) */
static int sheet_prelude(const char *t, int n, int i) {
	int d = 0, q = 0;
	for (; i < n; i++) {
		int c = (uint8_t)t[i];
		if (q) { if (c == '\\') { i++; } else if (c == q) { q = 0; } continue; }
		if (c == '"' || c == '\'') { q = c; } else if (c == '(') { d++; } else if (c == ')') { d--; } else if (d == 0 && (c == '{' || c == ';')) { return i; }
	}
	return n;
}
static JSValue sheet_str(JSContext *ctx, const char *s, int n) { return JS_NewStringLen(ctx, s, (size_t)(n > 0 ? n : 0)); }
static void sheet_push(JSContext *ctx, JSValue arr, uint32_t *len, JSValue v) { JS_SetPropertyUint32(ctx, arr, (*len)++, v); }

/* one declaration piece (trimmed, non-empty) of css.js parseDeclarations */
static void sheet_decl(JSContext *ctx, JSValue out, uint32_t *len, const char *d, int dn) {
	const char *colon = memchr(d, ':', (size_t)dn); if (!colon || colon == d) { return; }
	const char *nm = d; int nn = (int)(colon - d); trim(&nm, &nn);
	const char *v = colon + 1; int vn = dn - (int)(colon + 1 - d); trim(&v, &vn);
	int imp = 0;
	if (vn >= 9) {   /* /!\s*important\s*$/i (v is trimmed, so no trailing white space) */
		static const char lit[] = "important"; int ok = 1; for (int k = 0; k < 9; k++) { if (lc((uint8_t)v[vn - 9 + k]) != lit[k]) { ok = 0; break; } }
		if (ok) { int b = vn - 9, w; while (b > 0 && (w = ws_before(v, b)) > 0) { b -= w; } if (b > 0 && v[b - 1] == '!') { vn = b - 1; trim(&v, &vn); imp = 1; } }
	}
	char lower[256]; const char *name = nm;
	if (!(nn >= 2 && nm[0] == '-' && nm[1] == '-')) {
		if (nn > (int)sizeof lower) { sheet_fail = 1; return; }
		for (int k = 0; k < nn; k++) { unsigned c = (uint8_t)nm[k]; if (c >= 0x80) { sheet_fail = 1; return; } lower[k] = (char)lc(c); }   /* toLowerCase is Unicode-aware: leave non-ASCII to JavaScript */
		name = lower;
	}
	if (vn <= 0) { return; }
	JSValue o = JS_NewObject(ctx);
	JS_DefinePropertyValue(ctx, o, at_name, sheet_str(ctx, name, nn), JS_PROP_C_W_E); JS_DefinePropertyValue(ctx, o, at_value, sheet_str(ctx, v, vn), JS_PROP_C_W_E);
	JS_DefinePropertyValue(ctx, o, at_important, JS_NewBool(ctx, imp), JS_PROP_C_W_E);
	sheet_push(ctx, out, len, o);
}
/* css.js parseDeclarations: comments stripped, split at top-level ';' like dom.js splitDecls */
static JSValue sheet_decls(JSContext *ctx, const char *t0, int n0) {
	int n; char *t = sheet_strip(t0, n0, &n); JSValue out = JS_NewArray(ctx); uint32_t len = 0;
	int depth = 0, q = 0, start = 0;
	for (int i = 0; i < n && !sheet_fail; i++) {
		int c = (uint8_t)t[i];
		if (q) { if (c == '\\') { i++; } else if (c == q) { q = 0; } continue; }
		if (c == '"' || c == '\'') { q = c; } else if (c == '(') { depth++; } else if (c == ')') { depth--; }
		else if (c == ';' && depth == 0) { const char *p = t + start; int pn = i - start; trim(&p, &pn); if (pn > 0) { sheet_decl(ctx, out, &len, p, pn); } start = i + 1; }
	}
	if (!sheet_fail && start < n) { const char *p = t + start; int pn = n - start; trim(&p, &pn); if (pn > 0) { sheet_decl(ctx, out, &len, p, pn); } }   /* the last piece, whatever the quote/paren state */
	free(t); return out;
}
static int sheet_kw(const char *s, int n, const char *lit) { return ieq(s, n, lit); }
/* css.js parseRules */
static JSValue sheet_rules(JSContext *ctx, const char *t0, int n0) {
	int n; char *t = sheet_strip(t0, n0, &n); JSValue rules = JS_NewArray(ctx); uint32_t len = 0; int i = 0;
	while (i < n && !sheet_fail) {
		int w; while (i < n && (w = ws_at(t, n, i)) > 0) { i += w; } if (i >= n) { break; }
		if (t[i] == '@') {
			int end = sheet_prelude(t, n, i); const char *h = t + i; int hn = end - i; trim(&h, &hn);
			int m = 1; while (m < hn && ((h[m] >= 'a' && h[m] <= 'z') || (h[m] >= 'A' && h[m] <= 'Z') || (h[m] >= '0' && h[m] <= '9') || h[m] == '_' || h[m] == '-')) { m++; }
			if (m == 1) { sheet_fail = 1; break; }   /* /^@([\w-]+)/ fails: the JavaScript parser throws */
			const char *name = h + 1; int nl = m - 1; const char *pre = h + m; int pn = hn - m; trim(&pre, &pn);
			if (end < n && t[end] == '{') {
				int bend = sheet_block(t, n, end); const char *body = t + end + 1; int bn = bend - 1 - (end + 1); if (bn < 0) { bn = 0; } i = bend;
				int type = sheet_kw(name, nl, "media") ? 4 : sheet_kw(name, nl, "supports") ? 12 : (sheet_kw(name, nl, "layer") || sheet_kw(name, nl, "container") || sheet_kw(name, nl, "scope") || sheet_kw(name, nl, "document")) ? 0 : sheet_kw(name, nl, "font-face") ? 5 : -1;
				if (type >= 0) {
					JSValue it = JS_NewArray(ctx); JS_SetPropertyUint32(ctx, it, 0, JS_NewInt32(ctx, type)); JS_SetPropertyUint32(ctx, it, 1, sheet_str(ctx, pre, pn));
					JS_SetPropertyUint32(ctx, it, 2, type == 5 ? sheet_decls(ctx, body, bn) : sheet_rules(ctx, body, bn)); sheet_push(ctx, rules, &len, it);
				}
			} else { i = end + 1; }
			continue;
		}
		int end = sheet_prelude(t, n, i); if (end >= n || t[end] != '{') { break; }
		const char *sel = t + i; int sn = end - i; trim(&sel, &sn);
		int bend = sheet_block(t, n, end); const char *body = t + end + 1; int bn = bend - 1 - (end + 1); if (bn < 0) { bn = 0; } i = bend;
		JSValue it = JS_NewArray(ctx);
		if (memchr(body, '{', (size_t)bn)) { JS_SetPropertyUint32(ctx, it, 0, JS_NULL); JS_SetPropertyUint32(ctx, it, 1, sheet_str(ctx, sel, sn)); JS_SetPropertyUint32(ctx, it, 2, sheet_str(ctx, body, bn)); }
		else { JS_SetPropertyUint32(ctx, it, 0, sheet_str(ctx, sel, sn)); JS_SetPropertyUint32(ctx, it, 1, sheet_decls(ctx, body, bn)); }
		sheet_push(ctx, rules, &len, it);
	}
	free(t); return rules;
}
/* parseSheet(text) -> items (see above), or null */
static JSValue js_parse_sheet(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	if (!at_name) { at_name = JS_NewAtom(ctx, "name"); at_value = JS_NewAtom(ctx, "value"); at_important = JS_NewAtom(ctx, "important"); }
	size_t len; const char *s = JS_ToCStringLen(ctx, &len, argv[0]); if (!s) { return JS_EXCEPTION; }
	for (size_t i = 0; i + 1 < len; i++) { if ((uint8_t)s[i] == 0xED && (uint8_t)s[i + 1] >= 0xA0) { JS_FreeCString(ctx, s); return JS_NULL; } }   /* lone surrogates */
	sheet_fail = 0; JSValue r = sheet_rules(ctx, s, (int)len); JS_FreeCString(ctx, s);
	if (sheet_fail) { JS_FreeValue(ctx, r); return JS_NULL; }
	return r;
}
#define STYLE_SHEET_FUNCS JS_CFUNC_DEF("parseSheet", 1, js_parse_sheet),
