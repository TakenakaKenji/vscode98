/* spike:layout - a native port of 06-rendering/host/dom/layout.js (the layout half: block flow with margin collapsing, inline formatting with line breaking,
 * inline-block, flexbox, absolute/fixed/relative positioning, overflow/scroll geometry).
 *
 * Input: the styled box tree packed into flat arrays by layout_pack.js (field offsets F_* below must match F in layout_pack.js), calc() pool, UTF-16 text pool.
 * Output: typed arrays with per-box geometry, text fragments, inline-box line rectangles and the anonymous boxes created for text directly inside flex containers.
 * Same formulas and the same order of floating-point operations as the JavaScript, so the two can be compared exactly. Fonts are not parsed here: advances, kerning
 * pairs and vertical metrics come from the table filled through spike:render (render.c). Pure C99 + libm; one arena freed after each run; no platform calls.
 * `null` in the JavaScript (an indefinite height, a missing baseline) is NaN here.
 */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

int render_font_metrics(int id, double *asc, double *desc, double *gap);
double render_advance_em(int id, uint32_t cp);
double render_kern_em(int id, uint32_t a, uint32_t b);

enum { F_KIND = 0, F_PARENT = 1, F_DISPLAY = 2, F_FLAGS = 3, F_POS = 4, F_BORDERBOX = 5, F_MARGIN = 6, F_PADDING = 14, F_BORDER = 22, F_WIDTH = 26, F_HEIGHT = 28, F_MINW = 30, F_MINH = 32, F_MAXW = 34, F_MAXH = 36, F_OVX = 38, F_OVY = 39,
	F_FDIR = 40, F_FWRAP = 41, F_FGROW = 42, F_FSHRINK = 43, F_FBASIS = 44, F_ORDER = 46, F_AITEMS = 47, F_ASELF = 48, F_ACONTENT = 49, F_JUSTIFY = 50, F_ROWGAP = 51, F_COLGAP = 53, F_TOP = 55, F_LEFT = 57, F_RIGHT = 59, F_BOTTOM = 61,
	F_TALIGN = 63, F_WS = 64, F_BREAKALL = 65, F_OWRAP = 66, F_TAB = 67, F_LS = 68, F_WSP = 69, F_TTRANSFORM = 70, F_LH = 71, F_FSIZE = 72, F_FONT = 73, F_TEXT = 74, F_TEXTLEN = 75, F_TEXT2 = 76, F_TEXT2LEN = 77, F_REPLW = 78, F_REPLH = 79, F_STRIDE = 80 };
enum { K_BLOCK = 0, K_FLEX = 1, K_INLINE = 2, K_INLINE_BLOCK = 3, K_TEXT = 4, K_BR = 5 };
enum { POS_STATIC = 0, POS_RELATIVE = 1, POS_ABSOLUTE = 2, POS_FIXED = 3 };
enum { FLAG_OOF = 1, FLAG_REPLACED = 2, FLAG_PSEUDO = 4, FLAG_TRANSFORM = 8 };

/* ---------------------------------------------------------------- arena and vectors */
typedef struct Chunk { struct Chunk *next; size_t used, cap; char data[]; } Chunk;
static Chunk *arena;
static void *aalloc(size_t n) {
	n = (n + 15) & ~(size_t)15;
	if (!arena || arena->used + n > arena->cap) { size_t cap = n > (1u << 20) ? n : (1u << 20); Chunk *c = (Chunk *)calloc(1, sizeof(Chunk) + cap); c->cap = cap; c->next = arena; arena = c; }
	void *p = arena->data + arena->used; arena->used += n; return p;
}
static void arena_free(void) { while (arena) { Chunk *n = arena->next; free(arena); arena = n; } }
typedef struct { void **p; int n, cap; } PVec;
static void pv_push(PVec *v, void *x) { if (v->n == v->cap) { int nc = v->cap ? v->cap * 2 : 4; void **np = (void **)aalloc(sizeof(void *) * nc); if (v->n) { memcpy(np, v->p, sizeof(void *) * v->n); } v->p = np; v->cap = nc; } v->p[v->n++] = x; }

/* ---------------------------------------------------------------- data model */
typedef struct Line Line; typedef struct Box Box; typedef struct Frag Frag;
typedef struct { Line *line; double x, y, w, h, ax, ay; int hasA, fin; } IRect;
typedef struct { Box *box; PVec rects; double masc, mdesc; } IBox;   /* __rects of an inline box */
typedef struct { double size, min, max; int hasSize, hasMax, kw; } Spec;
struct Frag { int t; Box *box; double x, y, w, asc, desc, baseline, src, srcEnd, ls, size, trailing, boxBaseline, ax, ay, abaseline; int fontId; Line *line; uint16_t *text; int tlen, tcap; };
struct Line { double y, h, baseline, maxAsc, maxDesc, width, shift; int hasStrut; PVec items; };
struct Box {
	int idx, kind, display, flags, pos, oof, replaced, anon, hasLB, autoML, autoMR, autoMT, autoMB, hasStatic, hasMax, hasMin;
	Box *parent; PVec ch; double *s;
	double ox, oy, w, h, ax, ay, mt, mr, mb, ml, pt, pr, pb, pl, bt, br, bb, bl, hx, vy, cw, chh, scrollW, scrollH, relDx, relDy, lastBaseline, maxc, minc;
	PVec frags, irects; IBox *rects; double sx, sy; Box *spb; Line *sline;
	const uint16_t *text, *text2; int tlen, tlen2;
	/* flex transient */
	double mMain[2], mCross[2], extraMain, extraCross, basis, grow, shrink, minMain, maxMain, mainSize, target, crossOuter; int autoMain[2], hasMaxMain, frozen; Spec mainSpec, crossSpec;
	double resMt, resMb;   /* margins reported by the last layoutBlock (collapsing) */
};
typedef struct { int t; Box *box; const uint16_t *text, *text2; int tlen, tlen2; Box *vs; } Item;   /* 0 oof, 1 text, 2 br, 3 open, 4 close, 5 atomic */
typedef struct { Item *p; int n, cap; } ItemVec;
static void iv_push(ItemVec *v, Item it) { if (v->n == v->cap) { int nc = v->cap ? v->cap * 2 : 16; Item *np = (Item *)aalloc(sizeof(Item) * nc); if (v->n) { memcpy(np, v->p, sizeof(Item) * v->n); } v->p = np; v->cap = nc; } v->p[v->n++] = it; }

typedef struct {
	Box **boxes; int nboxes, nanon; PVec all;   /* all: packed boxes then anonymous ones, in creation order */
	const double *calc; double vw, vh; PVec oofList; double curCbw; int hasCurCbw;
	int *anonParent, *anonChild; int canon;
} L;
static L G;
static const double NaN_ = NAN;

/* ---------------------------------------------------------------- style access and lengths */
static inline const double *sty(const Box *b) { return b->kind == K_TEXT ? b->parent->s : b->s; }
static double eval_calc(int i, double base) {
	const double *n = &G.calc[i]; int k = (int)n[0];
	if (k == 0) { return n[1]; } if (k == 1) { return n[1] / 100 * base; }
	if (k == 2) { double a = eval_calc((int)n[2], base), b = eval_calc((int)n[3], base); int op = (int)n[1]; return op == '+' ? a + b : op == '-' ? a - b : op == '*' ? a * b : a / b; }
	int fn = (int)n[1], first = (int)n[2], cnt = (int)n[3]; double v[16]; if (cnt > 16) { cnt = 16; }
	for (int j = 0; j < cnt; j++) { v[j] = eval_calc((int)G.calc[first + j * 4 + 1], base); }
	if (fn == 0) { double m = INFINITY; for (int j = 0; j < cnt; j++) { if (isnan(v[j])) { return NAN; } if (v[j] < m) { m = v[j]; } } return m; }
	if (fn == 1) { double m = -INFINITY; for (int j = 0; j < cnt; j++) { if (isnan(v[j])) { return NAN; } if (v[j] > m) { m = v[j]; } } return m; }
	{ double lo = v[1] < v[2] ? v[1] : v[2]; return v[0] > lo ? v[0] : lo; }
}
/* resolveLen: returns 1 and the px value, or 0 for null (auto / none / keywords) */
static int rl(const double *p, double base, double *out) {
	switch ((int)p[0]) { case 1: *out = p[1]; return 1; case 2: *out = p[1] / 100 * base; return 1; case 3: case 4: *out = eval_calc((int)p[1], base); return 1; }
	return 0;
}
static double rl0(const double *p, double base) { double v; return rl(p, base, &v) ? v : 0; }
static inline double dmax(double a, double b) { return a > b ? a : b; }   /* Math.max for non-NaN operands */
static inline double dmin(double a, double b) { return a < b ? a : b; }
static double js_round(double v) { return floor(v + 0.5); }

typedef struct { double ascent, descent, lineHeightNormal; } Met;
static Met font_met(int fid, double size) {
	double asc = 0, desc = 0, gap = 0; render_font_metrics(fid, &asc, &desc, &gap); Met m; m.ascent = js_round(asc * size); m.descent = js_round(desc * size); m.lineHeightNormal = m.ascent + m.descent + js_round(gap * size); return m;
}
static double lh_of(const double *s, Met m) { double l = s[F_LH]; return isnan(l) ? m.lineHeightNormal : l; }

static void metrics(Box *b, double cbw) {
	const double *s = b->s;
	b->mt = rl0(&s[F_MARGIN], cbw); b->mr = rl0(&s[F_MARGIN + 2], cbw); b->mb = rl0(&s[F_MARGIN + 4], cbw); b->ml = rl0(&s[F_MARGIN + 6], cbw);
	b->autoMT = s[F_MARGIN] == 0 && s[F_MARGIN + 1] == 4; b->autoMR = s[F_MARGIN + 2] == 0 && s[F_MARGIN + 3] == 4; b->autoMB = s[F_MARGIN + 4] == 0 && s[F_MARGIN + 5] == 4; b->autoML = s[F_MARGIN + 6] == 0 && s[F_MARGIN + 7] == 4;
	b->pt = dmax(0, rl0(&s[F_PADDING], cbw)); b->pr = dmax(0, rl0(&s[F_PADDING + 2], cbw)); b->pb = dmax(0, rl0(&s[F_PADDING + 4], cbw)); b->pl = dmax(0, rl0(&s[F_PADDING + 6], cbw));
	b->bt = s[F_BORDER]; b->br = s[F_BORDER + 1]; b->bb = s[F_BORDER + 2]; b->bl = s[F_BORDER + 3];
	b->hx = b->pl + b->pr + b->bl + b->br; b->vy = b->pt + b->pb + b->bt + b->bb;
}
static int calc_has_pct_tag(const double *p) { return (int)p[0] == 4; }
static double max_content(Box *b); static double min_content(Box *b);
/* content-box size from width/height/min/max; cb NaN = indefinite */
static Spec spec_size(Box *b, int width, double cb) {
	const double *s = b->s; int bb = s[F_BORDERBOX] != 0; double extra = width ? b->hx : b->vy; Spec sp; memset(&sp, 0, sizeof sp);
	const double *sz = &s[width ? F_WIDTH : F_HEIGHT], *mn = &s[width ? F_MINW : F_MINH], *mx = &s[width ? F_MAXW : F_MAXH];
#define CONV(p, outv, outhas) do { outhas = 0; outv = 0; if ((int)(p)[0] != 0 && !(isnan(cb) && ((int)(p)[0] == 2 || calc_has_pct_tag(p)))) { double l; if (rl(p, isnan(cb) ? 0 : cb, &l)) { outv = dmax(0, bb ? l - extra : l); outhas = 1; } } } while (0)
	CONV(mx, sp.max, sp.hasMax);
	if (width && (int)mx[0] == 0 && mx[1] >= 1 && b->kind != K_TEXT) { sp.max = mx[1] == 1 ? min_content(b) : max_content(b); sp.hasMax = 1; }
	CONV(sz, sp.size, sp.hasSize); double mv; int mh; CONV(mn, mv, mh); sp.min = mh ? mv : 0; sp.kw = (int)sz[0] == 0 ? (int)sz[1] : 0;
#undef CONV
	return sp;
}
static double clamp_size(const Spec *s, double x) { double r = x; if (s->hasMax) { r = dmin(r, s->max); } return dmax(r, s->min); }

/* ---------------------------------------------------------------- text measurement */
static inline uint32_t cp_at(const uint16_t *t, int n, int i, int *len) {
	uint16_t c = t[i]; if (c >= 0xD800 && c < 0xDC00 && i + 1 < n && t[i + 1] >= 0xDC00 && t[i + 1] < 0xE000) { *len = 2; return 0x10000 + (((uint32_t)c - 0xD800) << 10) + (t[i + 1] - 0xDC00); } *len = 1; return c;
}
static double measure(int fid, const uint16_t *t, int n, double size, double ls, double wsp) {
	double w = 0; uint32_t prev = 0;
	for (int i = 0, l; i < n; i += l) { uint32_t cp = cp_at(t, n, i, &l); w += (render_advance_em(fid, cp) * size + ls) + (cp == 32 ? wsp : 0); if (ls == 0 && prev && prev != 32 && cp != 32) { w += render_kern_em(fid, prev, cp) * size; } prev = cp; }
	return w;
}
static double adv_px(int fid, uint32_t cp, double size) { return render_advance_em(fid, cp) * size; }

/* ---------------------------------------------------------------- boxes helpers */
static int ws_collapse(const double *s) { int w = (int)s[F_WS]; return w == 0 || w == 1 || w == 4; }
static int ws_wrap(const double *s) { int w = (int)s[F_WS]; return w == 0 || w == 3 || w == 4 || w == 5; }
static int ws_newlines(const double *s) { int w = (int)s[F_WS]; return w == 2 || w == 3 || w == 4 || w == 5; }
static int is_inline_level(const Box *c) { return c->oof || c->kind == K_TEXT || c->kind == K_INLINE || c->kind == K_INLINE_BLOCK || c->kind == K_BR; }
static int is_inline_container(Box *b) {
	if (b->kind == K_FLEX || b->replaced) { return 0; } if (b->ch.n == 0) { return 0; } int some = 0;
	for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (!is_inline_level(c)) { return 0; } if (!c->oof) { some = 1; } }
	return some;
}
static Box *new_anon(Box *parent, Box *textChild);
static void inline_items(Box **kids, int n, ItemVec *out) {
	for (int i = 0; i < n; i++) {
		Box *c = kids[i];
		if (c->oof) { Item it = { 0, c }; iv_push(out, it); continue; }
		if (c->kind == K_TEXT) { Item it = { 1, c, c->text, c->text2, c->tlen, c->tlen2, c->parent }; iv_push(out, it); }
		else if (c->kind == K_BR) { Item it = { 2, c }; iv_push(out, it); }
		else if (c->kind == K_INLINE) { metrics(c, G.hasCurCbw ? G.curCbw : 0); Item o = { 3, c }; iv_push(out, o); inline_items((Box **)c->ch.p, c->ch.n, out); Item cl = { 4, c }; iv_push(out, cl); }
		else { Item it = { 5, c }; iv_push(out, it); }
	}
}
typedef struct { Box *b; } Dummy;
static double outer_intrinsic(Box *c, int min);
static double inline_intrinsic(Box **kids, int n, int min) {
	ItemVec items = { 0 }; inline_items(kids, n, &items); double best = 0, cur = 0;
	for (int k = 0; k < items.n; k++) {
		Item *it = &items.p[k];
		if (it->t == 1) {
			const double *s = it->vs->s; int collapse = ws_collapse(s), wrap = ws_wrap(s), newl = ws_newlines(s); int fid = (int)s[F_FONT]; double size = s[F_FSIZE], ls = s[F_LS], wsp = s[F_WSP];
			/* t = text; if collapse: runs of [ \t\n\r\f] -> one space */
			uint16_t *t = (uint16_t *)aalloc(sizeof(uint16_t) * (it->tlen + 1)); int tn = 0;
			if (collapse) { int in = 0; for (int i = 0; i < it->tlen; i++) { uint16_t c = it->text[i]; if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f') { if (!in) { t[tn++] = ' '; in = 1; } } else { t[tn++] = c; in = 0; } } } else { memcpy(t, it->text, sizeof(uint16_t) * it->tlen); tn = it->tlen; }
			/* words: split after ' ', '\n', '-' when wrapping (lookbehind), else one word */
			int start = 0;
			while (start < tn || (start == 0 && tn == 0)) {
				int end = tn; if (wrap) { end = start; while (end < tn) { uint16_t c = t[end]; end++; if (c == ' ' || c == '\n' || c == '-') { break; } } } if (tn == 0) { end = 0; }
				int wl = end - start; const uint16_t *word = t + start; int endsNl = wl > 0 && word[wl - 1] == '\n'; int endsSp = wl > 0 && word[wl - 1] == ' ';
				double ww = measure(fid, word, endsNl ? wl - 1 : wl, size, ls, wsp);
				if (endsNl && newl) { cur += ww; best = dmax(best, cur); cur = 0; }
				else if (min) { double sp = 0; if (wrap && endsSp) { uint16_t one = ' '; sp = measure(fid, &one, 1, size, ls, wsp); } best = dmax(best, wrap ? ww - sp : ww); } else { cur += ww; }
				if (tn == 0) { break; } start = end;
			}
		} else if (it->t == 5) { double ow = outer_intrinsic(it->box, min); if (min) { best = dmax(best, ow); } else { cur += ow; } }
		else if (it->t == 3) { Box *b = it->box; double e = b->ml + b->pl + b->bl; if (!min) { cur += e; } }
		else if (it->t == 4) { Box *b = it->box; double e = b->mr + b->pr + b->br; if (!min) { cur += e; } }
		else if (it->t == 2) { best = dmax(best, cur); cur = 0; }
	}
	return dmax(best, cur);
}
static double outer_intrinsic(Box *c, int min) {
	if (c->kind == K_TEXT) { Box *k[1] = { c }; return inline_intrinsic(k, 1, min); }
	metrics(c, 0); Spec sp = spec_size(c, 1, NAN); double w;
	if (sp.hasSize) { w = sp.size; } else { w = min ? min_content(c) : max_content(c); } w = clamp_size(&sp, w);
	return w + c->hx + c->ml + c->mr;
}
static double gap_of(Box *b, int off, double base) { return rl0(&b->s[off], base); }
static double max_content(Box *b) {
	if (b->hasMax) { return b->maxc; } double w = 0;
	if (b->replaced) { w = b->s[F_REPLW]; }
	else if (is_inline_container(b)) { w = inline_intrinsic((Box **)b->ch.p, b->ch.n, 0); }
	else if (b->kind == K_FLEX) { int col = b->s[F_FDIR] >= 2; double sum = 0, mx = 0; double gap = gap_of(b, F_COLGAP, 0); int n = 0;
		for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof) { continue; } if (c->kind == K_TEXT) { int blank = 1; for (int j = 0; j < c->tlen; j++) { uint16_t ch = c->text[j]; if (!(ch == ' ' || (ch >= 9 && ch <= 13) || ch == 0xA0 || ch == 0xFEFF || ch == 0x2028 || ch == 0x2029 || ch == 0x1680 || (ch >= 0x2000 && ch <= 0x200A) || ch == 0x202F || ch == 0x205F || ch == 0x3000)) { blank = 0; break; } } if (blank) { continue; } } double ow = outer_intrinsic(c, 0); sum += ow; mx = dmax(mx, ow); n++; }
		w = col ? mx : sum + gap * dmax(0, n - 1); }
	else { for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof) { continue; } w = dmax(w, outer_intrinsic(c, 0)); } }
	b->maxc = w; b->hasMax = 1; return w;
}
static double min_content(Box *b) {
	if (b->hasMin) { return b->minc; } double w = 0;
	if (b->replaced) { w = b->s[F_REPLW]; }
	else if (is_inline_container(b)) { w = inline_intrinsic((Box **)b->ch.p, b->ch.n, 1); }
	else if (b->kind == K_FLEX) { int col = b->s[F_FDIR] >= 2; int wrap = b->s[F_FWRAP] != 0; double sum = 0, mx = 0; for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof) { continue; } double ow = outer_intrinsic(c, 1); sum += ow; mx = dmax(mx, ow); } w = col || wrap ? mx : sum; }
	else { for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof) { continue; } w = dmax(w, outer_intrinsic(c, 1)); } }
	b->minc = w; b->hasMin = 1; return w;
}

/* ---------------------------------------------------------------- block layout */
typedef struct { int hasForceW; double forceW; int hasForceH; double forceH; int shrink; } Opts;
static const Opts NOOPTS = { 0, 0, 0, 0, 0 };
typedef struct { double mtOut, mbOut; } Res;
static void layout_block(Box *b, double cbw, double cbh, Opts o);
static double layout_flow(Box *b, double cw, double ch, Res *res);
static double layout_flex(Box *b, double cw, double ch);
static int is_bfc_root(Box *b) { return !b->parent || b->oof || b->kind == K_INLINE_BLOCK || b->s[F_OVX] != 0 || b->s[F_OVY] != 0 || b->kind == K_FLEX || (b->parent && b->parent->kind == K_FLEX) || b->display == 3 || b->pos == POS_FIXED; }

static void layout_block(Box *b, double cbw, double cbh, Opts o) {
	b->frags.n = 0; b->irects.n = 0;
	metrics(b, cbw); Spec wSpec = spec_size(b, 1, cbw), hSpec = spec_size(b, 0, cbh); double cw;
	if (o.hasForceW) { cw = o.forceW - b->hx; }
	else if (wSpec.hasSize) { cw = clamp_size(&wSpec, wSpec.size); double rem = cbw - cw - b->hx - b->ml - b->mr; if (b->kind == K_BLOCK || b->kind == K_FLEX) { if (b->autoML && b->autoMR) { b->ml = b->mr = dmax(0, rem / 2); } else if (b->autoML) { b->ml = dmax(0, rem); } else if (b->autoMR) { b->mr = dmax(0, rem); } } }
	else if (b->kind == K_INLINE_BLOCK || wSpec.kw == 3 || wSpec.kw == 2 || wSpec.kw == 1 || o.shrink) {
		double avail = cbw - b->hx - b->ml - b->mr; double mx = max_content(b), mn = min_content(b);
		cw = wSpec.kw == 2 ? mx : wSpec.kw == 1 ? mn : dmin(dmax(mn, avail), mx); cw = clamp_size(&wSpec, cw);
	} else { cw = clamp_size(&wSpec, cbw - b->hx - b->ml - b->mr); }
	cw = dmax(0, cw);
	if (!o.hasForceW && (b->kind == K_BLOCK || b->kind == K_FLEX) && (b->autoML || b->autoMR)) { double rem = cbw - cw - b->hx - (b->autoML ? 0 : b->ml) - (b->autoMR ? 0 : b->mr); if (b->autoML && b->autoMR) { b->ml = dmax(0, rem / 2); b->mr = rem < 0 ? rem : b->ml; } else if (b->autoML) { b->ml = dmax(0, rem); } else { b->mr = dmax(0, rem); } }
	double ch = NAN; if (o.hasForceH) { ch = dmax(0, o.forceH - b->vy); } else if (hSpec.hasSize) { ch = clamp_size(&hSpec, hSpec.size); }
	Res res = { b->mt, b->mb }; double contentH; double savedCbw = G.curCbw; int savedHas = G.hasCurCbw; G.curCbw = cw; G.hasCurCbw = 1;
	if (b->replaced) { if (!wSpec.hasSize && !o.hasForceW) { cw = clamp_size(&wSpec, b->s[F_REPLW]); } contentH = !isnan(ch) ? ch : clamp_size(&hSpec, b->s[F_REPLH]); }
	else if (b->kind == K_FLEX || b->display == 2) { contentH = layout_flex(b, cw, ch); }
	else { contentH = layout_flow(b, cw, ch, &res); }
	G.curCbw = savedCbw; G.hasCurCbw = savedHas;
	if (!isnan(ch)) { contentH = ch; } else { contentH = clamp_size(&hSpec, contentH); }
	b->cw = cw; b->chh = contentH; b->w = cw + b->hx; b->h = contentH + b->vy; b->resMt = res.mtOut; b->resMb = res.mbOut;
}
static double collapse_m(double a, double b) { if (a >= 0 && b >= 0) { return dmax(a, b); } if (a < 0 && b < 0) { return dmin(a, b); } return a + b; }

/* ---------------------------------------------------------------- inline layout */
typedef struct { int hasHeight; double height; PVec frags, atomics, oofs, lines, inlineRects; int hasContent; double lastBaseline; int hasLB; } InlineOut;
static void shift_out(InlineOut *out, double dy) {
	for (int i = 0; i < out->frags.n; i++) { Frag *f = (Frag *)out->frags.p[i]; f->y += dy; if (f->t == 0) { f->baseline += dy; } }
	for (int i = 0; i < out->atomics.n; i++) { Frag *f = (Frag *)out->atomics.p[i]; f->box->oy += dy; }
	for (int i = 0; i < out->oofs.n; i++) { Box *o = (Box *)out->oofs.p[i]; o->oy += dy; if (o->hasStatic) { o->sy += dy; } }
	for (int i = 0; i < out->inlineRects.n; i++) { IBox *r = (IBox *)out->inlineRects.p[i]; for (int j = 0; j < r->rects.n; j++) { ((IRect *)r->rects.p[j])->y += dy; } }
}
static void frag_append(Frag *f, const uint16_t *s, int n) { if (f->tlen + n > f->tcap) { int nc = f->tcap ? f->tcap : 16; while (nc < f->tlen + n) { nc *= 2; } uint16_t *nt = (uint16_t *)aalloc(sizeof(uint16_t) * nc); if (f->tlen) { memcpy(nt, f->text, sizeof(uint16_t) * f->tlen); } f->text = nt; f->tcap = nc; } memcpy(f->text + f->tlen, s, sizeof(uint16_t) * n); f->tlen += n; }

typedef struct { Box *container; double cw; double x; Line *line; PVec lines, stack; PVec frags, atomics, oofs, inlineRects; int hasContent, prevSpace; const double *cs; int cvFont; double cvSize; Met cvMet; Frag *cur; } LI;
static void li_new_line(LI *s) {
	Line *l = (Line *)aalloc(sizeof(Line)); pv_push(&s->lines, l); s->line = l; s->x = 0; s->prevSpace = 1;
	double strutLh = lh_of(s->cs, s->cvMet); double hl = strutLh - (s->cvMet.ascent + s->cvMet.descent), half = floor(hl / 2); l->maxAsc = s->cvMet.ascent + half; l->maxDesc = s->cvMet.descent + (hl - half); l->hasStrut = 0;
}
static void li_start_inline_boxes(LI *s) {
	for (int i = 0; i < s->stack.n; i++) { Box *b = (Box *)s->stack.p[i]; IBox *ib = b->rects; IRect *last = ib->rects.n ? (IRect *)ib->rects.p[ib->rects.n - 1] : NULL; if (!last || last->line != s->line) { IRect *r = (IRect *)aalloc(sizeof(IRect)); r->line = s->line; r->x = s->x; pv_push(&ib->rects, r); } }
}
static void li_contribute(LI *s, double asc, double desc) { s->line->maxAsc = dmax(s->line->maxAsc, asc); s->line->maxDesc = dmax(s->line->maxDesc, desc); }
static void li_finish_line(LI *s) {
	Line *L = s->line; Box *container = s->container; L->h = L->maxAsc + L->maxDesc; L->baseline = L->maxAsc;
	double end = 0; for (int i = 0; i < L->items.n; i++) { Frag *it = (Frag *)L->items.p[i]; end = dmax(end, it->x + it->w - it->trailing); } L->width = end;
	double free_ = s->cw - end; double shift = 0; int align = (int)container->s[F_TALIGN]; if (align == 1) { shift = dmax(0, free_ / 2); } else if (align == 2) { shift = dmax(0, free_); }
	L->shift = shift; for (int i = 0; i < L->items.n; i++) { Frag *it = (Frag *)L->items.p[i]; it->x += shift; if (it->t == 1) { it->box->ox = it->x + container->bl + container->pl + it->box->ml; } }
	double top = L->y; for (int i = 0; i < L->items.n; i++) { Frag *it = (Frag *)L->items.p[i]; if (it->t == 0) { it->y = top + L->baseline - it->asc; it->baseline = top + L->baseline; } else { it->box->oy = top + L->baseline - it->boxBaseline + it->box->mt + container->bt + container->pt; } }
	for (int i = 0; i < s->inlineRects.n; i++) { IBox *r = (IBox *)s->inlineRects.p[i]; for (int j = 0; j < r->rects.n; j++) { IRect *q = (IRect *)r->rects.p[j]; if (q->line == L && !q->fin) { q->fin = 1; q->x += shift; q->y = top + L->baseline - r->masc - r->box->pt - r->box->bt; q->h = r->masc + r->mdesc + r->box->pt + r->box->pb + r->box->bt + r->box->bb; } } }
}
static void li_next_line(LI *s) { li_finish_line(s); Line *prev = s->line; li_new_line(s); s->line->y = prev->y + prev->h; }
static Frag *li_start_frag(LI *s, Item *it, double srcPos, int fid, double size, double ls, Met met, double half, double halfB) {
	li_start_inline_boxes(s); Frag *f = (Frag *)aalloc(sizeof(Frag)); f->t = 0; f->box = it->box; f->x = s->x; f->asc = met.ascent; f->desc = met.descent; f->src = srcPos; f->srcEnd = srcPos; f->fontId = fid; f->size = size; f->ls = ls; f->line = s->line;
	pv_push(&s->line->items, f); pv_push(&s->frags, f); li_contribute(s, met.ascent + half, met.descent + halfB); return f;
}
static double li_add_text(LI *s, Item *it, const uint16_t *t, int n, double srcStart, double srcEnd, int isSpace, int fid, double size, double ls, double wsp, Met met, double half, double halfB) {
	if (!s->cur || s->cur->line != s->line) { s->cur = li_start_frag(s, it, srcStart, fid, size, ls, met, half, halfB); }
	int nsp = 0; if (isSpace) { for (int i = 0; i < n; i++) { if (t[i] == ' ') { nsp++; } } }
	double wdt = measure(fid, t, n, size, ls, wsp) + (isSpace ? wsp * (double)nsp : 0);
	frag_append(s->cur, t, n); s->cur->w += wdt; s->cur->srcEnd = srcEnd; s->x += wdt; s->hasContent = 1; s->line->hasStrut = 1; return wdt;
}
static int is_ws_char(uint16_t c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'; }

static InlineOut layout_inline(Box *container, Box **run, int nrun, double cw, double y0, double chDefinite) {
	ItemVec items = { 0 }; inline_items(run, nrun, &items); const double *cs = container->s; LI S; memset(&S, 0, sizeof S); S.container = container; S.cw = cw; S.cs = cs; S.cvFont = (int)cs[F_FONT]; S.cvSize = cs[F_FSIZE]; S.cvMet = font_met(S.cvFont, S.cvSize);
	int alignWrap = ws_wrap(cs);
	li_new_line(&S);
	for (int idx = 0; idx < items.n; idx++) {
		Item *it = &items.p[idx];
		if (it->t == 3) {
			Box *b = it->box; int fid = (int)b->s[F_FONT]; double size = b->s[F_FSIZE]; Met m = font_met(fid, size);
			IBox *ib = (IBox *)aalloc(sizeof(IBox)); ib->box = b; ib->masc = m.ascent; ib->mdesc = m.descent; b->rects = ib; pv_push(&S.inlineRects, ib); pv_push(&S.stack, b); li_start_inline_boxes(&S);
			double e = b->ml + b->bl + b->pl; S.x += e; S.hasContent = S.hasContent || e > 0; double lh = lh_of(b->s, m); double hl = lh - (m.ascent + m.descent), half = floor(hl / 2); li_contribute(&S, m.ascent + half, m.descent + (hl - half));
		}
		else if (it->t == 4) { Box *b = it->box; double e = b->mr + b->br + b->pr; S.x += e; S.stack.n--; IBox *ib = b->rects; if (ib && ib->rects.n) { IRect *q = (IRect *)ib->rects.p[ib->rects.n - 1]; q->w = S.x - q->x; } }
		else if (it->t == 0) { Box *o = it->box; o->hasStatic = 1; o->sx = S.x; o->sy = 0; o->spb = container; o->sline = S.line; pv_push(&S.oofs, o); o->ox = container->bl + container->pl + S.x; o->oy = container->bt + container->pt + S.line->y; }
		else if (it->t == 2) { S.hasContent = 1; S.line->hasStrut = 1; li_next_line(&S); }
		else if (it->t == 5) {
			Box *b = it->box; li_start_inline_boxes(&S); metrics(b, cw); layout_block(b, cw, chDefinite, NOOPTS); double ow = b->w + b->ml + b->mr;
			if (S.x + ow > cw + 1e-6 && S.line->items.n > 0 && alignWrap) { li_next_line(&S); li_start_inline_boxes(&S); }
			double baseline = b->h + b->mb; if (b->hasLB && b->s[F_OVX] == 0 && b->s[F_OVY] == 0) { baseline = b->lastBaseline + b->mt; } else { baseline = b->h + b->mt; }
			double asc = baseline, desc = b->h + b->mt + b->mb - baseline; li_contribute(&S, asc, desc);
			Frag *f = (Frag *)aalloc(sizeof(Frag)); f->t = 1; f->box = b; f->x = S.x; f->w = ow; f->boxBaseline = baseline; b->ox = 0; pv_push(&S.line->items, f); pv_push(&S.frags, f); pv_push(&S.atomics, f); S.x += ow; S.hasContent = 1; S.prevSpace = 0; S.line->hasStrut = 1;
		}
		else if (it->t == 1) {
			const double *s2 = it->vs->s; int collapse = ws_collapse(s2), wrap = ws_wrap(s2), newl = ws_newlines(s2); int fid = (int)s2[F_FONT]; double size = s2[F_FSIZE]; Met met = font_met(fid, size); double ls = s2[F_LS]; double lh = lh_of(s2, met); double hl = lh - (met.ascent + met.descent), half = floor(hl / 2), halfB = hl - half;
			double wsp = s2[F_WSP]; double tabSize = s2[F_TAB]; const uint16_t *text = it->text2; int n = it->tlen2; int breakAll = s2[F_BREAKALL] != 0, overflowWrap = s2[F_OWRAP] != 0; int pre_wrap_ws = (int)s2[F_WS] == 3;
			S.cur = NULL; int i = 0;
			while (i < n) {
				uint16_t c = text[i]; int kind, tsrc = i, tend; const uint16_t *ts; int tn;
				if (c == '\n' && newl) { kind = 0; tend = i + 1; ts = NULL; tn = 0; }
				else if (is_ws_char(c)) { int j = i; while (j < n && (text[j] == ' ' || text[j] == '\t' || ((text[j] == '\n' || text[j] == '\r' || text[j] == '\f') && !(text[j] == '\n' && newl)))) { j++; } kind = 1; tend = j; if (collapse) { static const uint16_t sp1 = ' '; ts = &sp1; tn = 1; } else { ts = text + i; tn = j - i; } }
				else { int j = i; while (j < n && !is_ws_char(text[j])) { j++; } kind = 2; tend = j; ts = text + i; tn = j - i; }
				i = (tend == i) ? i + 1 : tend;
				if (kind == 0) { S.hasContent = 1; S.line->hasStrut = 1; if (!S.cur || S.cur->line != S.line) { S.cur = li_start_frag(&S, it, 0, fid, size, ls, met, half, halfB); } li_next_line(&S); S.cur = NULL; S.prevSpace = 1; continue; }
				if (kind == 1) {
					if (collapse) { if (S.prevSpace) { continue; } }
					const uint16_t *sp = ts; int sn = tn;
					if (!collapse) { int hasTab = 0; for (int q = 0; q < tn; q++) { if (ts[q] == '\t') { hasTab = 1; break; } } if (hasTab) {
						double spw = adv_px(fid, 32, size) + ls; uint16_t *outb = (uint16_t *)aalloc(sizeof(uint16_t) * (size_t)(tn * 64 + 8)); int on = 0; double xx = S.x;
						for (int q = 0; q < tn; q++) { if (ts[q] == '\t') { double stop = tabSize * spw; double nx = floor((xx - 0) / stop + 1e-9) * stop + stop; int cnt = (int)dmax(1, js_round((nx - xx) / spw)); if (cnt > 60) { cnt = 60; } for (int z = 0; z < cnt; z++) { outb[on++] = ' '; } xx += cnt * spw; } else { outb[on++] = ts[q]; xx += spw; } }
						sp = outb; sn = on; } }
					double swd = measure(fid, sp, sn, size, ls, wsp) + wsp;
					if (wrap && !collapse && S.x + swd > cw + 1e-6 && S.line->items.n > 0 && !pre_wrap_ws) { li_next_line(&S); S.cur = NULL; }
					li_add_text(&S, it, sp, sn, tsrc, tend, 1, fid, size, ls, wsp, met, half, halfB); S.prevSpace = collapse; if (collapse && S.cur) { S.cur->trailing = swd; }
					continue;
				}
				/* word */
				double ww = measure(fid, ts, tn, size, ls, wsp);
				if (S.cur && S.cur->trailing) { S.cur->trailing = 0; }
				if (wrap && S.x + ww > cw + 1e-6 && S.line->items.n > 0) {
					if (S.cur && S.cur->line == S.line && S.cur->tlen > 0 && S.cur->text[S.cur->tlen - 1] == ' ' && collapse) { uint16_t one = ' '; double sw = measure(fid, &one, 1, size, ls, wsp) + wsp; S.cur->tlen--; S.cur->w -= sw; S.x -= sw; }
					li_next_line(&S); S.cur = NULL; S.prevSpace = 1;
				}
				if (wrap && ww > cw - S.x + 1e-6 && (breakAll || overflowWrap)) {
					int start = tsrc; const uint16_t *rest = ts; int rn = tn;
					while (rn > 0) {
						int k = 0, kunits = 0; double acc = 0;
						while (kunits < rn) { int l; cp_at(rest, rn, kunits, &l); double cw1 = measure(fid, rest + kunits, l, size, ls, wsp); if (S.x + acc + cw1 > cw + 1e-6 && (k > 0 || S.line->items.n > 0)) { break; } acc += cw1; k++; kunits += l; }
						if (k == 0) { li_next_line(&S); S.cur = NULL; continue; }
						li_add_text(&S, it, rest, kunits, start, start + kunits, 0, fid, size, ls, wsp, met, half, halfB); start += kunits; rest += kunits; rn -= kunits;
						if (rn > 0) { li_next_line(&S); S.cur = NULL; }
					}
					S.prevSpace = 0; continue;
				}
				li_add_text(&S, it, ts, tn, tsrc, tend, 0, fid, size, ls, wsp, met, half, halfB); S.prevSpace = 0;
			}
		}
	}
	InlineOut out; memset(&out, 0, sizeof out); out.frags = S.frags; out.atomics = S.atomics; out.oofs = S.oofs; out.lines = S.lines; out.inlineRects = S.inlineRects;
	Line *last = (Line *)S.lines.p[S.lines.n - 1]; if (last->items.n == 0 && !last->hasStrut && S.lines.n > 1) { S.lines.n--; S.line = (Line *)S.lines.p[S.lines.n - 1]; out.lines = S.lines; }
	int emptyOnly = S.lines.n == 1 && ((Line *)S.lines.p[0])->items.n == 0 && !((Line *)S.lines.p[0])->hasStrut && !S.hasContent;
	if (emptyOnly) { for (int i = 0; i < S.oofs.n; i++) { ((Box *)S.oofs.p[i])->sy = y0; } out.hasHeight = 1; out.height = 0; out.lines.n = 0; out.hasContent = 0; out.hasLB = 0; return out; }
	li_finish_line(&S); double h = 0; for (int i = 0; i < S.lines.n; i++) { Line *L = (Line *)S.lines.p[i]; h = dmax(h, L->y + L->h); }
	double ox = container->bl + container->pl, oy = container->bt + container->pt;
	for (int i = 0; i < S.frags.n; i++) { Frag *f = (Frag *)S.frags.p[i]; if (f->t == 0) { f->x += ox; f->y += oy; f->baseline += oy; } }
	for (int i = 0; i < S.inlineRects.n; i++) { IBox *r = (IBox *)S.inlineRects.p[i]; for (int j = 0; j < r->rects.n; j++) { IRect *q = (IRect *)r->rects.p[j]; q->x += ox; q->y += oy; } }
	for (int i = 0; i < S.oofs.n; i++) { Box *o = (Box *)S.oofs.p[i]; o->sx = o->sx + (S.lines.n ? ((Line *)S.lines.p[0])->shift : 0); o->sy = o->sline ? o->sline->y : 0; }
	for (int i = 0; i < S.frags.n; i++) { pv_push(&container->frags, S.frags.p[i]); } for (int i = 0; i < S.inlineRects.n; i++) { pv_push(&container->irects, S.inlineRects.p[i]); }
	Line *lastLine = (Line *)S.lines.p[S.lines.n - 1]; out.hasHeight = 1; out.height = h; out.hasContent = 1; out.lastBaseline = lastLine->y + lastLine->baseline; out.hasLB = 1; (void)chDefinite; return out;
}

static double layout_flow(Box *b, double cw, double ch, Res *res) {
	int collapsible = !is_bfc_root(b); int topAdj = collapsible && b->pt == 0 && b->bt == 0, botAdj = collapsible && b->pb == 0 && b->bb == 0 && isnan(ch);
	double y = 0, pending = 0; int hasPending = 0, first = 1; res->mtOut = b->mt; double lastBaseline = 0; int hasLB = 0; int i = 0;
	while (i < b->ch.n) {
		Box *c = (Box *)b->ch.p[i];
		if (c->oof) { c->hasStatic = 1; c->sx = 0; c->sy = y + (hasPending ? pending : 0); c->spb = b; c->sline = NULL; c->ox = b->bl + b->pl; c->oy = b->bt + b->pt + y + (hasPending ? pending : 0); i++; continue; }
		if (c->kind == K_TEXT || c->kind == K_INLINE || c->kind == K_INLINE_BLOCK || c->kind == K_BR) {
			int j = i; while (j < b->ch.n && is_inline_level((Box *)b->ch.p[j])) { j++; }
			InlineOut out = layout_inline(b, (Box **)&b->ch.p[i], j - i, cw, y + (hasPending ? pending : 0), ch);
			if (out.height > 0 || out.hasContent) { double adj = hasPending ? pending : 0; y += adj; hasPending = 0; for (int k = 0; k < out.lines.n; k++) { ((Line *)out.lines.p[k])->y += y; } shift_out(&out, y); y += out.height; first = 0; if (out.hasLB) { hasLB = 1; lastBaseline = y - out.height + out.lastBaseline; } }
			else { shift_out(&out, y + (hasPending ? pending : 0)); }
			i = j; continue;
		}
		layout_block(c, cw, ch, NOOPTS);
		double mt = c->resMt, gap;
		if (first && topAdj) { res->mtOut = collapse_m(b->mt, mt); gap = 0; } else if (!hasPending) { gap = mt; } else { gap = collapse_m(pending, mt); }
		if (!(first && topAdj)) { y += gap; }
		c->ox = b->bl + b->pl + c->ml; c->oy = b->bt + b->pt + y; y += c->h; pending = c->resMb; hasPending = 1; first = 0; if (c->hasLB) { hasLB = 1; lastBaseline = c->oy - b->bt - b->pt + c->lastBaseline; }
		i++;
	}
	if (botAdj) { res->mbOut = collapse_m(b->mb, hasPending ? pending : 0); if (!hasPending) { res->mbOut = b->mb; } }
	else { if (hasPending) { y += pending; } res->mbOut = b->mb; }
	if (hasLB) { b->hasLB = 1; b->lastBaseline = lastBaseline + b->bt + b->pt; } else { b->hasLB = 0; }
	return y;
}

/* ---------------------------------------------------------------- flex */
typedef struct { PVec items; double main, free_, avail, cross; } FLine;
static int is_js_blank(const uint16_t *t, int n) { for (int j = 0; j < n; j++) { uint16_t ch = t[j]; if (!(ch == ' ' || (ch >= 9 && ch <= 13) || ch == 0xA0 || ch == 0xFEFF || ch == 0x2028 || ch == 0x2029 || ch == 0x1680 || (ch >= 0x2000 && ch <= 0x200A) || ch == 0x202F || ch == 0x205F || ch == 0x3000)) { return 0; } } return 1; }
static Box *new_anon(Box *parent, Box *textChild) {
	Box *a = (Box *)aalloc(sizeof(Box)); a->kind = K_BLOCK; a->display = 0; a->anon = 1; a->parent = parent; a->idx = G.all.n; pv_push(&G.all, a);
	double *s = (double *)aalloc(sizeof(double) * F_STRIDE); memcpy(s, parent->s, sizeof(double) * F_STRIDE); a->s = s;
	s[F_KIND] = K_BLOCK; s[F_DISPLAY] = 0; s[F_FLAGS] = (double)((int)s[F_FLAGS] & FLAG_TRANSFORM); s[F_POS] = POS_STATIC;
	for (int k = F_MARGIN; k < F_BORDER + 4; k++) { s[k] = 0; } for (int k = F_WIDTH; k <= F_MAXH + 1; k++) { s[k] = 0; }
	s[F_FGROW] = 0; s[F_FSHRINK] = 1; s[F_FBASIS] = 0; s[F_FBASIS + 1] = 0; s[F_ORDER] = 0; s[F_ASELF] = 0;
	a->pos = POS_STATIC; a->maxc = a->minc = 0; pv_push(&a->ch, textChild); textChild->parent = a;   /* JS sets c.parent = anon at creation */
	a->mt = 0; return a;
}
static double flex_axis(Box *b) { return 0; }
static void layout_flex_impl(Box *box, double cw, double ch, double *outContentH);
static double layout_flex(Box *box, double cw, double ch) { double r; layout_flex_impl(box, cw, ch, &r); return r; }
static int cmp_order(Box *a, Box *b) { return a->s[F_ORDER] > b->s[F_ORDER] ? 1 : a->s[F_ORDER] < b->s[F_ORDER] ? -1 : 0; }
static void layout_flex_impl(Box *box, double cw, double ch, double *outContentH) {
	const double *v = box->s; int dir = (int)v[F_FDIR]; int row = dir == 0 || dir == 1; int rev = dir == 1 || dir == 3; int wrap = v[F_FWRAP] != 0;
	double colGap = gap_of(box, F_COLGAP, cw), rowGap = gap_of(box, F_ROWGAP, isnan(ch) ? 0 : ch); double mainGap = row ? colGap : rowGap, crossGap = row ? rowGap : colGap;
	PVec items = { 0 }; PVec anons = { 0 };
	for (int i = 0; i < box->ch.n; i++) {
		Box *c = (Box *)box->ch.p[i];
		if (c->oof) { c->hasStatic = 1; c->sx = 0; c->sy = 0; c->spb = box; c->sline = NULL; c->ox = box->bl + box->pl; c->oy = box->bt + box->pt; continue; }
		if (c->kind == K_TEXT) { if (is_js_blank(c->text, c->tlen)) { continue; } Box *a = new_anon(box, c); pv_push(&items, a); pv_push(&anons, a); G.canon++; continue; }
		pv_push(&items, c);
	}
	/* stable sort by order */
	for (int i = 1; i < items.n; i++) { Box *k = (Box *)items.p[i]; int j = i - 1; while (j >= 0 && cmp_order((Box *)items.p[j], k) > 0) { items.p[j + 1] = items.p[j]; j--; } items.p[j + 1] = k; }
	double mainAvail = row ? cw : ch; double crossAvail = row ? ch : cw;
	for (int ii = 0; ii < items.n; ii++) {
		Box *it = (Box *)items.p[ii]; metrics(it, cw); const double *iv = it->s;
		if (row) { it->mMain[0] = it->ml; it->mMain[1] = it->mr; it->mCross[0] = it->mt; it->mCross[1] = it->mb; it->autoMain[0] = it->autoML; it->autoMain[1] = it->autoMR; }
		else { it->mMain[0] = it->mt; it->mMain[1] = it->mb; it->mCross[0] = it->ml; it->mCross[1] = it->mr; it->autoMain[0] = it->autoMT; it->autoMain[1] = it->autoMB; }
		Spec wSpec = spec_size(it, 1, cw), hSpec = spec_size(it, 0, ch); it->mainSpec = row ? wSpec : hSpec; it->crossSpec = row ? hSpec : wSpec;
		it->extraMain = row ? it->hx : it->vy; it->extraCross = row ? it->vy : it->hx;
		double bpx = 0; int hasB = 0; const double *basis = &iv[F_FBASIS];
		if ((int)basis[0] == 0 && (basis[1] == 0 || basis[1] == 1)) { if (it->mainSpec.hasSize) { bpx = it->mainSpec.size; hasB = 1; } }
		else { double l; double base = isnan(mainAvail) ? 0 : mainAvail; if (rl(basis, base, &l)) { bpx = iv[F_BORDERBOX] != 0 ? dmax(0, l - it->extraMain) : l; hasB = 1; } }
		if (!hasB) {
			if (row) { bpx = max_content(it); if (wSpec.kw == 1) { bpx = min_content(it); } }
			else { layout_block(it, cw, NAN, NOOPTS); bpx = it->h - it->vy; }
		}
		it->basis = clamp_size(&it->mainSpec, bpx); it->grow = iv[F_FGROW]; it->shrink = iv[F_FSHRINK];
		it->minMain = it->mainSpec.min; it->maxMain = it->mainSpec.max; it->hasMaxMain = it->mainSpec.hasMax;
		if (it->mainSpec.min == 0 && !it->mainSpec.hasSize && iv[F_OVX] == 0) { it->minMain = dmin(row ? min_content(it) : 0, it->basis); }
	}
	/* split into lines */
	PVec lines = { 0 }; FLine *cur = (FLine *)aalloc(sizeof(FLine)); cur->main = 0;
	for (int ii = 0; ii < items.n; ii++) { Box *it = (Box *)items.p[ii]; double outer = it->basis + it->extraMain + it->mMain[0] + it->mMain[1]; if (wrap && cur->items.n && !isnan(mainAvail) && cur->main + mainGap + outer > mainAvail + 1e-6) { pv_push(&lines, cur); cur = (FLine *)aalloc(sizeof(FLine)); cur->main = 0; } cur->main += (cur->items.n ? mainGap : 0) + outer; pv_push(&cur->items, it); }
	if (cur->items.n || !lines.n) { pv_push(&lines, cur); }
	for (int li = 0; li < lines.n; li++) {
		FLine *ln = (FLine *)lines.p[li]; double avail = isnan(mainAvail) ? ln->main : mainAvail; double free_ = avail - ln->main; double sumGrow = 0, sumShrink = 0;
		for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; sumGrow = sumGrow + i->grow; sumShrink = sumShrink + i->shrink * i->basis; }
		for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; i->mainSize = i->basis; i->frozen = 0; }
		if (free_ > 0 && sumGrow > 0) {
			int guard = 0; double remaining = free_;
			while (guard++ < 10) {
				double grow = 0; for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; if (!i->frozen) { grow = grow + i->grow; } } if (grow <= 0) { break; }
				int violated = 0;
				for (int k = 0; k < ln->items.n; k++) { Box *it = (Box *)ln->items.p[k]; if (it->frozen) { continue; } double t = it->basis + remaining * (it->grow / (grow < 1 ? 1 : grow)) * (grow < 1 ? grow : 1); double mx = it->hasMaxMain ? it->maxMain : INFINITY; double c = dmin(mx, dmax(it->minMain, t)); if (c != t) { it->frozen = 1; it->mainSize = c; violated = 1; remaining -= (c - it->basis); } else { it->target = t; } }
				if (!violated) { for (int k = 0; k < ln->items.n; k++) { Box *it = (Box *)ln->items.p[k]; if (!it->frozen) { it->mainSize = it->target; } } break; }
			}
		} else if (free_ < 0 && sumShrink > 0) {
			int guard = 0; double remaining = free_;
			while (guard++ < 10) {
				double tot = 0; for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; if (!i->frozen) { tot = tot + i->shrink * i->basis; } } if (tot <= 0) { break; }
				int violated = 0;
				for (int k = 0; k < ln->items.n; k++) { Box *it = (Box *)ln->items.p[k]; if (it->frozen) { continue; } double t = it->basis + remaining * (it->shrink * it->basis / tot); double mx = it->hasMaxMain ? it->maxMain : INFINITY; double c = dmin(mx, dmax(it->minMain, t)); if (c != t) { it->frozen = 1; it->mainSize = c; violated = 1; remaining -= (c - it->basis); } else { it->target = t; } }
				if (!violated) { for (int k = 0; k < ln->items.n; k++) { Box *it = (Box *)ln->items.p[k]; if (!it->frozen) { it->mainSize = it->target; } } break; }
			}
		}
		double used = 0; for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; used = used + i->mainSize + i->extraMain + i->mMain[0] + i->mMain[1]; } used = used + mainGap * dmax(0, ln->items.n - 1); ln->free_ = avail - used; ln->avail = avail;
		int autos = 0; for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; autos += (i->autoMain[0] ? 1 : 0) + (i->autoMain[1] ? 1 : 0); }
		if (autos && ln->free_ > 0) { double share = ln->free_ / autos; for (int k = 0; k < ln->items.n; k++) { Box *i = (Box *)ln->items.p[k]; if (i->autoMain[0]) { i->mMain[0] = share; } if (i->autoMain[1]) { i->mMain[1] = share; } } ln->free_ = 0; }
	}
	for (int li = 0; li < lines.n; li++) {
		FLine *ln = (FLine *)lines.p[li]; double crossMax = 0;
		for (int k = 0; k < ln->items.n; k++) {
			Box *it = (Box *)ln->items.p[k]; double wMain = it->mainSize + it->extraMain; Opts o = { 0, 0, 0, 0, 0 };
			if (row) { o.hasForceW = 1; o.forceW = wMain; if (it->crossSpec.hasSize) { o.hasForceH = 1; o.forceH = clamp_size(&it->crossSpec, it->crossSpec.size) + it->vy; } layout_block(it, cw, ch, o); }
			else { if (it->crossSpec.hasSize) { o.hasForceW = 1; o.forceW = clamp_size(&it->crossSpec, it->crossSpec.size) + it->hx; } o.hasForceH = 1; o.forceH = wMain; layout_block(it, cw, ch, o); }
			it->crossOuter = (row ? it->h : it->w) + it->mCross[0] + it->mCross[1]; crossMax = dmax(crossMax, it->crossOuter);
		}
		ln->cross = crossMax;
	}
	int single = lines.n == 1; double containerCross = crossAvail;
	if (single && !isnan(containerCross)) { ((FLine *)lines.p[0])->cross = containerCross; }
	double totalCross = 0; for (int li = 0; li < lines.n; li++) { totalCross = totalCross + ((FLine *)lines.p[li])->cross; } totalCross = totalCross + crossGap * (lines.n - 1);
	int alignContent = (int)v[F_ACONTENT]; double crossStart = 0, crossSpace = 0;
	if (!single && !isnan(containerCross)) { double free_ = containerCross - totalCross; if (alignContent == 1) { crossStart = free_ / 2; } else if (alignContent == 2) { crossStart = free_; } else if (alignContent == 3 && lines.n > 1) { crossSpace = free_ / (lines.n - 1); } else if (alignContent == 4) { double add = dmax(0, free_) / lines.n; for (int li = 0; li < lines.n; li++) { ((FLine *)lines.p[li])->cross += add; } } }
	int jc = (int)v[F_JUSTIFY]; int ai = (int)v[F_AITEMS]; double cursorCross = crossStart; double baseX = box->bl + box->pl, baseY = box->bt + box->pt;
	for (int li = 0; li < lines.n; li++) {
		FLine *ln = (FLine *)lines.p[li]; double startMain = 0, between = 0;
		if (ln->free_ > 0) { if (jc == 1) { startMain = ln->free_ / 2; } else if (jc == 2) { startMain = ln->free_; } else if (jc == 3 && ln->items.n > 1) { between = ln->free_ / (ln->items.n - 1); } else if (jc == 4) { between = ln->free_ / ln->items.n; startMain = between / 2; } else if (jc == 5) { between = ln->free_ / (ln->items.n + 1); startMain = between; } }
		for (int k = 0; k < ln->items.n; k++) {
			Box *it = (Box *)ln->items.p[k]; int as = (int)it->s[F_ASELF] == 0 ? ai : (int)it->s[F_ASELF];
			int autoCrossAny = row ? (it->autoMT || it->autoMB) : (it->autoML || it->autoMR);
			int stretch = (as == 1 || as == 2) && !it->crossSpec.hasSize && !autoCrossAny;
			if (stretch) { double target = ln->cross - it->mCross[0] - it->mCross[1]; Opts o = { 0, 0, 0, 0, 0 };
				if (row) { o.hasForceW = 1; o.forceW = it->mainSize + it->extraMain; o.hasForceH = 1; o.forceH = dmax(clamp_size(&it->crossSpec, target - it->vy) + it->vy, 0); layout_block(it, cw, ch, o); }
				else { o.hasForceW = 1; o.forceW = clamp_size(&it->crossSpec, target - it->hx) + it->hx; o.hasForceH = 1; o.forceH = it->mainSize + it->extraMain; layout_block(it, cw, ch, o); } }
			else if (!row && !it->crossSpec.hasSize) { double avail = ln->cross - it->mCross[0] - it->mCross[1]; double w = dmin(dmax(min_content(it), avail - it->hx), max_content(it)) + it->hx; Opts o = { 1, w, 1, it->mainSize + it->extraMain, 0 }; layout_block(it, cw, ch, o); }
		}
		double p = startMain; double pm = rev ? ln->avail - startMain : startMain;
		for (int k = 0; k < ln->items.n; k++) {
			Box *it = (Box *)ln->items.p[k]; double outerMain = it->mainSize + it->extraMain + it->mMain[0] + it->mMain[1]; double mainOff;
			if (rev) { pm -= outerMain; mainOff = pm + it->mMain[0]; pm -= between + mainGap; } else { mainOff = p + it->mMain[0]; p += outerMain + between + mainGap; }
			int as = (int)it->s[F_ASELF] == 0 ? ai : (int)it->s[F_ASELF]; double crossOuterNow = (row ? it->h : it->w) + it->mCross[0] + it->mCross[1]; double crossOff = 0; double free_ = ln->cross - crossOuterNow;
			int autoC0 = row ? it->autoMT : it->autoML, autoC1 = row ? it->autoMB : it->autoMR;
			if (autoC0 && autoC1) { crossOff = free_ / 2; } else if (autoC0) { crossOff = free_; } else if (as == 3) { crossOff = free_ / 2; } else if (as == 4) { crossOff = free_; }
			double cx = cursorCross + crossOff + it->mCross[0];
			if (row) { it->ox = baseX + mainOff; it->oy = baseY + cx; } else { it->ox = baseX + cx; it->oy = baseY + mainOff; }
		}
		cursorCross += ln->cross + crossGap + crossSpace;
	}
	/* anonymous boxes replace their text child in the box's child list */
	for (int a = 0; a < anons.n; a++) { Box *an = (Box *)anons.p[a]; Box *t = (Box *)an->ch.p[0]; for (int i = 0; i < box->ch.n; i++) { if (box->ch.p[i] == t) { box->ch.p[i] = an; break; } } }
	double mainUsed = 0; for (int li = 0; li < lines.n; li++) { FLine *l = (FLine *)lines.p[li]; mainUsed = dmax(mainUsed, l->avail - l->free_); }
	double contentH = row ? totalCross : (!isnan(ch) ? ch : mainUsed); if (row && !isnan(ch)) { contentH = ch; }
	*outContentH = contentH; (void)flex_axis;
}

/* ---------------------------------------------------------------- positioning */
static void absolutize(Box *b, double px, double py) {
	b->ax = px + b->ox; b->ay = py + b->oy;
	if (b->pos == POS_RELATIVE) { const double *v = b->s; Box *cb = b->parent; double cw = cb ? cb->w : 0, chh = cb ? cb->h : 0; double l, r, t, bt; int hl = rl(&v[F_LEFT], cw, &l), hr = rl(&v[F_RIGHT], cw, &r), ht = rl(&v[F_TOP], chh, &t), hb = rl(&v[F_BOTTOM], chh, &bt); b->relDx = hl ? l : (hr ? -r : 0); b->relDy = ht ? t : (hb ? -bt : 0); b->ax += b->relDx; b->ay += b->relDy; }
	for (int i = 0; i < b->frags.n; i++) { Frag *f = (Frag *)b->frags.p[i]; f->ax = b->ax + f->x; f->ay = b->ay + f->y; f->abaseline = b->ay + f->baseline; }
	for (int i = 0; i < b->irects.n; i++) { IBox *r = (IBox *)b->irects.p[i]; for (int j = 0; j < r->rects.n; j++) { IRect *q = (IRect *)r->rects.p[j]; q->ax = b->ax + q->x; q->ay = b->ay + q->y; q->hasA = 1; } }
	for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof) { continue; } if (c->kind == K_INLINE || c->kind == K_TEXT) { continue; } absolutize(c, b->ax, b->ay); }
}
typedef struct { double x, y, w, h; Box *box; int hasRect; IBox *irect0; } CB;
static CB containing_block(Box *b) {
	CB cb; memset(&cb, 0, sizeof cb);
	if (b->pos == POS_FIXED) { cb.x = 0; cb.y = 0; cb.w = G.vw; cb.h = G.vh; return cb; }
	for (Box *p = b->parent; p; p = p->parent) {
		if (p->pos != POS_STATIC || ((int)p->s[F_FLAGS] & FLAG_TRANSFORM)) {
			if (p->kind == K_INLINE && p->rects && p->rects->rects.n) { IRect *r = (IRect *)p->rects->rects.p[0]; cb.x = r->ax; cb.y = r->ay; cb.w = r->w; cb.h = r->h; cb.box = p; return cb; }
			cb.x = p->ax + p->bl; cb.y = p->ay + p->bt; cb.w = p->w - p->bl - p->br; cb.h = p->h - p->bt - p->bb; cb.box = p; return cb;
		}
	}
	cb.x = 0; cb.y = 0; cb.w = G.vw; cb.h = G.vh; return cb;
}
static void static_abs(Box *b, double *x, double *y) { if (!b->hasStatic || !b->spb) { *x = 0; *y = 0; return; } Box *p = b->spb; *x = p->ax + p->bl + p->pl + b->sx; *y = p->ay + p->bt + p->pt + b->sy; }
static void layout_oof(Box *b) {
	const double *v = b->s; CB cb = containing_block(b); metrics(b, cb.w);
	double L, R, T, B; int hL = rl(&v[F_LEFT], cb.w, &L), hR = rl(&v[F_RIGHT], cb.w, &R), hT = rl(&v[F_TOP], cb.h, &T), hB = rl(&v[F_BOTTOM], cb.h, &B);
	Spec wSpec = spec_size(b, 1, cb.w), hSpec = spec_size(b, 0, cb.h); double forceW = 0; int hasW = 0, shrink = 0;
	if (wSpec.hasSize) { forceW = clamp_size(&wSpec, wSpec.size) + b->hx; hasW = 1; }
	else if (hL && hR) { forceW = clamp_size(&wSpec, cb.w - L - R - b->ml - b->mr - b->hx) + b->hx; hasW = 1; }
	else { shrink = 1; }
	double forceH = 0; int hasH = 0; if (hSpec.hasSize) { forceH = clamp_size(&hSpec, hSpec.size) + b->vy; hasH = 1; } else if (hT && hB) { forceH = clamp_size(&hSpec, cb.h - T - B - b->mt - b->mb - b->vy) + b->vy; hasH = 1; }
	if (shrink) { double avail = dmax(0, cb.w - (hL ? L : 0) - (hR ? R : 0) - b->ml - b->mr - b->hx); double mx = max_content(b), mn = min_content(b); forceW = clamp_size(&wSpec, dmin(dmax(mn, avail), mx)) + b->hx; hasW = 1; }
	b->hasMax = 0; b->hasMin = 0;
	Opts o = { hasW, forceW, hasH, forceH, 0 }; layout_block(b, cb.w, cb.h, o);
	double x, y, sx, sy;
	if (hL) { x = cb.x + L + b->ml; } else if (hR) { x = cb.x + cb.w - R - b->mr - b->w; } else { static_abs(b, &sx, &sy); x = sx + b->ml; }
	if (hT) { y = cb.y + T + b->mt; } else if (hB) { y = cb.y + cb.h - B - b->mb - b->h; } else { static_abs(b, &sx, &sy); y = sy + b->mt; }
	b->ax = x; b->ay = y; b->ox = 0; b->oy = 0;
	for (int i = 0; i < b->frags.n; i++) { Frag *f = (Frag *)b->frags.p[i]; f->ax = b->ax + f->x; f->ay = b->ay + f->y; f->abaseline = b->ay + f->baseline; }
	for (int i = 0; i < b->irects.n; i++) { IBox *r = (IBox *)b->irects.p[i]; for (int j = 0; j < r->rects.n; j++) { IRect *q = (IRect *)r->rects.p[j]; q->ax = b->ax + q->x; q->ay = b->ay + q->y; q->hasA = 1; } }
	for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof || c->kind == K_INLINE || c->kind == K_TEXT) { continue; } absolutize(c, b->ax, b->ay); }
}
static void compute_scroll(Box *b);
static void gather(Box *b, Box *c, double px, double py, double *right, double *bottom) {
	if (c->kind == K_TEXT) { return; }
	if (c->kind == K_INLINE) { if (c->rects) { for (int j = 0; j < c->rects->rects.n; j++) { IRect *r = (IRect *)c->rects->rects.p[j]; if (r->hasA) { *right = dmax(*right, (r->ax - px) + r->w); *bottom = dmax(*bottom, (r->ay - py) + r->h); } } } for (int i = 0; i < c->ch.n; i++) { gather(b, (Box *)c->ch.p[i], px, py, right, bottom); } return; }
	compute_scroll(c); *right = dmax(*right, (c->ax - px + 0) + c->w); *bottom = dmax(*bottom, (c->ay - py + 0) + c->h);
	if (c->s[F_OVX] == 0 && c->s[F_OVY] == 0) { *right = dmax(*right, (c->ax - px + 0) + c->scrollW); *bottom = dmax(*bottom, (c->ay - py + 0) + c->scrollH); }
}
static void compute_scroll(Box *b) {
	double right = 0, bottom = 0; double px = b->ax + b->bl, py = b->ay + b->bt;
	for (int i = 0; i < b->ch.n; i++) { gather(b, (Box *)b->ch.p[i], px, py, &right, &bottom); }
	for (int i = 0; i < b->frags.n; i++) { Frag *f = (Frag *)b->frags.p[i]; if (f->t == 0) { right = dmax(right, (f->ax - px) + f->w); bottom = dmax(bottom, (f->ay - py) + (f->asc + f->desc)); } }
	double cw = b->w - b->bl - b->br, ch = b->h - b->bt - b->bb; b->scrollW = dmax(cw, right); b->scrollH = dmax(ch, bottom);
}
static void collect_oof(Box *b) { for (int i = 0; i < b->ch.n; i++) { Box *c = (Box *)b->ch.p[i]; if (c->oof) { pv_push(&G.oofList, c); } collect_oof(c); } }

/* ---------------------------------------------------------------- JS entry point */
static int get_f64(JSContext *ctx, JSValueConst v, double **out, size_t *count) {
	size_t off, len, bpe; JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe); if (JS_IsException(buf)) { return -1; }
	size_t sz; uint8_t *p = JS_GetArrayBuffer(ctx, &sz, buf); JS_FreeValue(ctx, buf); if (!p) { return -1; } *out = (double *)(p + off); *count = len / sizeof(double); return 0;
}
static int get_u16(JSContext *ctx, JSValueConst v, uint16_t **out, size_t *count) {
	size_t off, len, bpe; JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe); if (JS_IsException(buf)) { return -1; }
	size_t sz; uint8_t *p = JS_GetArrayBuffer(ctx, &sz, buf); JS_FreeValue(ctx, buf); if (!p) { return -1; } *out = (uint16_t *)(p + off); *count = len / sizeof(uint16_t); return 0;
}
enum { BO_AX, BO_AY, BO_W, BO_H, BO_BL, BO_BT, BO_BR, BO_BB, BO_HX, BO_VY, BO_SCROLLW, BO_SCROLLH, BO_RELDX, BO_RELDY, BO_STRIDE };
enum { FO_OWNER, FO_TEXTBOX, FO_X, FO_Y, FO_W, FO_ASC, FO_DESC, FO_BASELINE, FO_SRC, FO_SRCEND, FO_LS, FO_SIZE, FO_FONT, FO_AX, FO_AY, FO_ABASELINE, FO_TEXTOFF, FO_TEXTLEN, FO_STRIDE };
enum { RO_BOX, RO_X, RO_Y, RO_W, RO_H, RO_AX, RO_AY, RO_HASA, RO_STRIDE };

static JSValue new_f64_array(JSContext *ctx, const double *src, size_t n) {
	JSValue ab = JS_NewArrayBufferCopy(ctx, (const uint8_t *)src, n * sizeof(double)); JSValue g = JS_GetGlobalObject(ctx); JSValue ctor = JS_GetPropertyStr(ctx, g, "Float64Array"); JSValue arr = JS_CallConstructor(ctx, ctor, 1, &ab); JS_FreeValue(ctx, ctor); JS_FreeValue(ctx, g); JS_FreeValue(ctx, ab); return arr;
}
static JSValue new_u16_array(JSContext *ctx, const uint16_t *src, size_t n) {
	JSValue ab = JS_NewArrayBufferCopy(ctx, (const uint8_t *)src, n * sizeof(uint16_t)); JSValue g = JS_GetGlobalObject(ctx); JSValue ctor = JS_GetPropertyStr(ctx, g, "Uint16Array"); JSValue arr = JS_CallConstructor(ctx, ctor, 1, &ab); JS_FreeValue(ctx, ctor); JS_FreeValue(ctx, g); JS_FreeValue(ctx, ab); return arr;
}
/* layout(boxes Float64Array, nboxes, calc Float64Array, text Uint16Array, vw, vh) -> { boxes, frags, fragText, rects, anons, oofCount } */
static JSValue js_layout(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	double *rec; size_t rn; double *calc; size_t cn; uint16_t *text; size_t tn; int nb; double vw, vh;
	if (get_f64(ctx, argv[0], &rec, &rn) < 0) { return JS_EXCEPTION; } JS_ToInt32(ctx, &nb, argv[1]); if (get_f64(ctx, argv[2], &calc, &cn) < 0) { return JS_EXCEPTION; } if (get_u16(ctx, argv[3], &text, &tn) < 0) { return JS_EXCEPTION; }
	JS_ToFloat64(ctx, &vw, argv[4]); JS_ToFloat64(ctx, &vh, argv[5]);
	memset(&G, 0, sizeof G); G.calc = calc; G.vw = vw; G.vh = vh; G.nboxes = nb;
	/* build boxes */
	Box **boxes = (Box **)aalloc(sizeof(Box *) * (nb + 1));
	for (int i = 0; i < nb; i++) {
		Box *b = (Box *)aalloc(sizeof(Box)); boxes[i] = b; b->idx = i; b->s = &rec[(size_t)i * F_STRIDE]; const double *s = b->s; b->kind = (int)s[F_KIND]; b->display = (int)s[F_DISPLAY]; b->flags = (int)s[F_FLAGS]; b->pos = (int)s[F_POS];
		b->oof = (b->flags & FLAG_OOF) != 0; b->replaced = (b->flags & FLAG_REPLACED) != 0; pv_push(&G.all, b);
		if (b->kind == K_TEXT) { b->text = text + (size_t)s[F_TEXT]; b->tlen = (int)s[F_TEXTLEN]; b->text2 = text + (size_t)s[F_TEXT2]; b->tlen2 = (int)s[F_TEXT2LEN]; }
		int p = (int)s[F_PARENT]; if (p >= 0) { b->parent = boxes[p]; pv_push(&b->parent->ch, b); }
	}
	G.boxes = boxes;
	Box *root = nb ? boxes[0] : NULL;
	if (root) {
		collect_oof(root); layout_block(root, vw, vh, (Opts){ 1, vw, 0, 0, 0 }); root->ox = 0; root->oy = 0; absolutize(root, 0, 0);
		for (int i = 0; i < G.oofList.n; i++) { layout_oof((Box *)G.oofList.p[i]); }
		compute_scroll(root);
	}
	/* results */
	int total = G.all.n; double *bo = (double *)calloc((size_t)(total ? total : 1) * BO_STRIDE, sizeof(double));
	int nfr = 0, nrc = 0, ntext = 0;
	for (int i = 0; i < total; i++) { Box *b = (Box *)G.all.p[i]; for (int k = 0; k < b->frags.n; k++) { Frag *f = (Frag *)b->frags.p[k]; if (f->t == 0) { nfr++; ntext += f->tlen; } } if (b->kind == K_INLINE && b->rects) { nrc += b->rects->rects.n; } }
	double *fo = (double *)calloc((size_t)(nfr ? nfr : 1) * FO_STRIDE, sizeof(double)); uint16_t *ft = (uint16_t *)calloc((size_t)(ntext ? ntext : 1), sizeof(uint16_t)); double *ro = (double *)calloc((size_t)(nrc ? nrc : 1) * RO_STRIDE, sizeof(double)); double *ao = (double *)calloc((size_t)(G.canon ? G.canon : 1) * 4, sizeof(double));
	int fi = 0, ri = 0, to = 0, ai = 0;
	for (int i = 0; i < total; i++) {
		Box *b = (Box *)G.all.p[i]; double *o = &bo[(size_t)i * BO_STRIDE];
		o[BO_AX] = b->ax; o[BO_AY] = b->ay; o[BO_W] = b->w; o[BO_H] = b->h; o[BO_BL] = b->bl; o[BO_BT] = b->bt; o[BO_BR] = b->br; o[BO_BB] = b->bb; o[BO_HX] = b->hx; o[BO_VY] = b->vy; o[BO_SCROLLW] = b->scrollW; o[BO_SCROLLH] = b->scrollH; o[BO_RELDX] = b->relDx; o[BO_RELDY] = b->relDy;
		for (int k = 0; k < b->frags.n; k++) { Frag *f = (Frag *)b->frags.p[k]; if (f->t != 0) { continue; } double *q = &fo[(size_t)fi++ * FO_STRIDE];
			q[FO_OWNER] = i; q[FO_TEXTBOX] = f->box->idx; q[FO_X] = f->x; q[FO_Y] = f->y; q[FO_W] = f->w; q[FO_ASC] = f->asc; q[FO_DESC] = f->desc; q[FO_BASELINE] = f->baseline; q[FO_SRC] = f->src; q[FO_SRCEND] = f->srcEnd; q[FO_LS] = f->ls; q[FO_SIZE] = f->size; q[FO_FONT] = f->fontId; q[FO_AX] = f->ax; q[FO_AY] = f->ay; q[FO_ABASELINE] = f->abaseline; q[FO_TEXTOFF] = to; q[FO_TEXTLEN] = f->tlen;
			if (f->tlen) { memcpy(ft + to, f->text, sizeof(uint16_t) * f->tlen); } to += f->tlen; }
		if (b->kind == K_INLINE && b->rects) { for (int k = 0; k < b->rects->rects.n; k++) { IRect *r = (IRect *)b->rects->rects.p[k]; double *q = &ro[(size_t)ri++ * RO_STRIDE]; q[RO_BOX] = i; q[RO_X] = r->x; q[RO_Y] = r->y; q[RO_W] = r->w; q[RO_H] = r->h; q[RO_AX] = r->ax; q[RO_AY] = r->ay; q[RO_HASA] = r->hasA; } }
		if (b->anon) { double *q = &ao[(size_t)ai++ * 4]; q[0] = i; q[1] = b->parent->idx; q[2] = ((Box *)b->ch.p[0])->idx; q[3] = 0; }
	}
	JSValue r = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, r, "boxes", new_f64_array(ctx, bo, (size_t)total * BO_STRIDE)); JS_SetPropertyStr(ctx, r, "frags", new_f64_array(ctx, fo, (size_t)nfr * FO_STRIDE)); JS_SetPropertyStr(ctx, r, "fragText", new_u16_array(ctx, ft, (size_t)ntext));
	JS_SetPropertyStr(ctx, r, "rects", new_f64_array(ctx, ro, (size_t)nrc * RO_STRIDE)); JS_SetPropertyStr(ctx, r, "anons", new_f64_array(ctx, ao, (size_t)ai * 4)); JS_SetPropertyStr(ctx, r, "total", JS_NewInt32(ctx, total));
	free(bo); free(fo); free(ft); free(ro); free(ao); arena_free(); return r;
}
static const JSCFunctionListEntry lfuncs[] = { JS_CFUNC_DEF("layout", 6, js_layout) };
static int layout_init(JSContext *ctx, JSModuleDef *m) { return JS_SetModuleExportList(ctx, m, lfuncs, 1); }
void spike_init_layout(JSContext *ctx) { JSModuleDef *m = JS_NewCModule(ctx, "spike:layout", layout_init); if (m) { JS_AddModuleExportList(ctx, m, lfuncs, 1); } }
