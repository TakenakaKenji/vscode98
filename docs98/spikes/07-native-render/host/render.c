/* spike:render - a native software rasterizer for QuickJS-ng.
 *
 * Executes a display list (a Float64 command stream recorded by JavaScript, see native_backend.js) into an RGBA framebuffer owned by JavaScript:
 * rectangles, rounded rectangles, clip stack, opacity layers and glyph runs (non-zero-winding scanline coverage with a per-size/sub-pixel glyph cache).
 * It is a line-for-line port of the JavaScript backend in 06-rendering/host/dom/paint.js (same formulas, same operation order, same rounding) so that the
 * two can be compared byte for byte. Font parsing stays in JavaScript: JS supplies advances, kerning pairs and outlines (in font units) the first time a
 * glyph is used; nothing here parses a font file. Pure C99 + libm, no platform calls, so it builds for Windows 98/XP/7 unchanged.
 */
#include <math.h>
#include <time.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"
#if defined(_WIN32)
/* profiling timer only (QueryPerformanceCounter, available from Windows 2000; winpthreads' clock_gettime pulls in newer APIs) */
#include <windows.h>
static void prof_now(struct timespec *ts) { LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); ts->tv_sec = (long)(c.QuadPart / f.QuadPart); ts->tv_nsec = (long)((c.QuadPart % f.QuadPart) * 1000000000LL / f.QuadPart); }
#else
static void prof_now(struct timespec *ts) { clock_gettime(CLOCK_MONOTONIC, ts); }
#endif

/* ---------------------------------------------------------------- hash map (uint64 key -> pointer or double) */
typedef struct { uint64_t key; int used; union { void *p; double d; } v; } Slot;
typedef struct { Slot *s; size_t cap, n; } Map;
static uint64_t mix(uint64_t k) { k ^= k >> 33; k *= 0xff51afd7ed558ccdULL; k ^= k >> 33; k *= 0xc4ceb9fe1a85ec53ULL; k ^= k >> 33; return k; }
static Slot *map_find(Map *m, uint64_t key, int insert) {
	if (!m->cap) { if (!insert) { return NULL; } m->cap = 64; m->s = (Slot *)calloc(m->cap, sizeof(Slot)); }
	if (insert && (m->n + 1) * 2 > m->cap) {
		Map nm = { (Slot *)calloc(m->cap * 2, sizeof(Slot)), m->cap * 2, 0 };
		for (size_t i = 0; i < m->cap; i++) { if (m->s[i].used) { Slot *d = map_find(&nm, m->s[i].key, 1); d->v = m->s[i].v; } }
		free(m->s); *m = nm;
	}
	size_t i = (size_t)mix(key) & (m->cap - 1);
	for (;;) { Slot *s = &m->s[i]; if (!s->used) { if (!insert) { return NULL; } s->used = 1; s->key = key; m->n++; return s; } if (s->key == key) { return s; } i = (i + 1) & (m->cap - 1); }
}

/* ---------------------------------------------------------------- fonts and glyphs */
typedef struct { double adv; int ncmd; double *cmd; } Outline;   /* adv in em; cmd: groups of 7 doubles {type,x,y,x1,y1,x2,y2} in font units */
typedef struct { int left, top, w, h, empty; uint8_t *cov; } Glyph;
typedef struct { double upm, asc, desc, gap; Map outlines, kerns, glyphs, iglyphs; } Font;   /* asc/desc/gap: hhea metrics in em */
static Font fonts[256]; static int nfonts;
static uint8_t GAMMA[256]; static int gamma_init;

typedef struct { double x0, y0, x1, y1, dxdy; int dir; } Edge;
typedef struct { Edge *e; int n, cap; } Edges;
static void edge_line(Edges *E, double x0, double y0, double x1, double y1) {
	if (y0 == y1) { return; }
	if (E->n == E->cap) { E->cap = E->cap ? E->cap * 2 : 64; E->e = (Edge *)realloc(E->e, E->cap * sizeof(Edge)); }
	Edge *e = &E->e[E->n++]; e->x0 = x0; e->y0 = y0; e->x1 = x1; e->y1 = y1; e->dir = 0; e->dxdy = 0;
}
static void edge_quad(Edges *E, double x0, double y0, double x1, double y1, double x2, double y2) {
	const int n = 8; double px = x0, py = y0;
	for (int i = 1; i <= n; i++) { double t = (double)i / n, u = 1 - t; double x = u * u * x0 + 2 * u * t * x1 + t * t * x2, y = u * u * y0 + 2 * u * t * y1 + t * t * y2; edge_line(E, px, py, x, y); px = x; py = y; }
}
static void edge_cubic(Edges *E, double x0, double y0, double x1, double y1, double x2, double y2, double x3, double y3) {
	const int n = 10; double px = x0, py = y0;
	for (int i = 1; i <= n; i++) { double t = (double)i / n, u = 1 - t; double x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3; edge_line(E, px, py, x, y); px = x; py = y; }
}
static double js_round(double v) { return floor(v + 0.5); }
typedef struct { double x; int dir; } Cross;

/* Build (and cache) the coverage bitmap of one glyph at `size` px with sub-pixel x offset fx (a multiple of 1/4). */
static double size_tab[1024]; static int nsizes;
static int size_index(double size) { for (int i = 0; i < nsizes; i++) { if (size_tab[i] == size) { return i; } } if (nsizes < 1024) { size_tab[nsizes] = size; return nsizes++; } return 1023; }
static Glyph *get_glyph(Font *f, int fontId, uint32_t cp, double size, int fxq, long *misses) {
	uint64_t key = (uint64_t)cp | ((uint64_t)fxq << 21) | ((uint64_t)size_index(size) << 24);   /* exact key: code point, quarter-pixel offset, index of the distinct size */
	Slot *sl = map_find(&f->glyphs, key, 0); if (sl) { return (Glyph *)sl->v.p; }
	(*misses)++;
	Glyph *g = (Glyph *)calloc(1, sizeof(Glyph)); sl = map_find(&f->glyphs, key, 1); sl->v.p = g;
	Slot *os = map_find(&f->outlines, cp, 0); if (!os) { g->empty = 1; return g; }
	Outline *o = (Outline *)os->v.p; double fx = fxq / 4.0, scale = 1 / f->upm * size;
	Edges E = { 0, 0, 0 }; double sx = 0, sy = 0, cx = 0, cy = 0;
	for (int i = 0; i < o->ncmd; i++) {
		const double *c = &o->cmd[i * 7]; int type = (int)c[0];
		double X = fx + c[1] * scale, Y = 0 + -c[2] * scale, X1 = fx + c[3] * scale, Y1 = 0 + -c[4] * scale, X2 = fx + c[5] * scale, Y2 = 0 + -c[6] * scale;
		switch (type) {
		case 0: if (cx != sx || cy != sy) { edge_line(&E, cx, cy, sx, sy); } sx = cx = X; sy = cy = Y; break;
		case 1: edge_line(&E, cx, cy, X, Y); cx = X; cy = Y; break;
		case 2: edge_quad(&E, cx, cy, X1, Y1, X, Y); cx = X; cy = Y; break;
		case 3: edge_cubic(&E, cx, cy, X1, Y1, X2, Y2, X, Y); cx = X; cy = Y; break;
		case 4: edge_line(&E, cx, cy, sx, sy); cx = sx; cy = sy; break;
		}
	}
	if (cx != sx || cy != sy) { edge_line(&E, cx, cy, sx, sy); }
	if (!E.n) { g->empty = 1; free(E.e); return g; }
	double minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
	for (int i = 0; i < E.n; i++) { Edge *e = &E.e[i]; minX = fmin(minX, fmin(e->x0, e->x1)); maxX = fmax(maxX, fmax(e->x0, e->x1)); minY = fmin(minY, fmin(e->y0, e->y1)); maxY = fmax(maxY, fmax(e->y0, e->y1)); }
	int left = (int)floor(minX) - 1, top = (int)floor(minY) - 1, w = (int)ceil(maxX) + 1 - left, h = (int)ceil(maxY) + 1 - top;
	for (int i = 0; i < E.n; i++) {
		Edge *e = &E.e[i]; double x0r = e->x0, y0r = e->y0, x1r = e->x1, y1r = e->y1;
		if (y0r < y1r) { e->x0 = x0r - left; e->y0 = y0r - top; e->x1 = x1r - left; e->y1 = y1r - top; e->dir = 1; } else { e->x0 = x1r - left; e->y0 = y1r - top; e->x1 = x0r - left; e->y1 = y0r - top; e->dir = -1; }
		e->dxdy = (e->x1 - e->x0) / (e->y1 - e->y0);
	}
	uint8_t *cov = (uint8_t *)calloc((size_t)w * h, 1); float *rowAcc = (float *)calloc((size_t)w + 1, sizeof(float)); const int SUB = 4; Cross *xs = (Cross *)malloc(sizeof(Cross) * (E.n + 1));
	for (int y = 0; y < h; y++) {
		memset(rowAcc, 0, ((size_t)w + 1) * sizeof(float));
		for (int sy2 = 0; sy2 < SUB; sy2++) {
			double ys = y + (sy2 + 0.5) / SUB; int nx = 0;
			for (int i = 0; i < E.n; i++) { Edge *e = &E.e[i]; if (ys >= e->y0 && ys < e->y1) { xs[nx].x = e->x0 + (ys - e->y0) * e->dxdy; xs[nx].dir = e->dir; nx++; } }
			if (nx < 2) { continue; }
			for (int i = 1; i < nx; i++) { Cross k = xs[i]; int j = i - 1; while (j >= 0 && xs[j].x > k.x) { xs[j + 1] = xs[j]; j--; } xs[j + 1] = k; }   /* stable, like Array.prototype.sort */
			int wind = 0;
			for (int i = 0; i < nx - 1; i++) {
				wind += xs[i].dir; if (wind == 0) { continue; }
				double xa = fmax(0, xs[i].x), xb = fmin((double)w, xs[i + 1].x); if (xb <= xa) { continue; }
				int ia = (int)floor(xa), ib = (int)floor(xb);
				if (ia == ib) { rowAcc[ia] = (float)((double)rowAcc[ia] + (xb - xa)); }
				else { rowAcc[ia] = (float)((double)rowAcc[ia] + (ia + 1 - xa)); for (int xi = ia + 1; xi < ib; xi++) { rowAcc[xi] = (float)((double)rowAcc[xi] + 1); } if (ib < w) { rowAcc[ib] = (float)((double)rowAcc[ib] + (xb - ib)); } }
			}
		}
		for (int x = 0; x < w; x++) { double v = js_round((double)rowAcc[x] / SUB * 255); cov[(size_t)y * w + x] = (uint8_t)(v > 255 ? 255 : v); }
	}
	free(xs); free(rowAcc); free(E.e);
	g->left = left; g->top = top; g->w = w; g->h = h; g->cov = cov; (void)fontId; return g;
}

/* ---------------------------------------------------------------- surface, blend */
/* px is addressed as px[(y * w + x) * 4] with absolute coordinates. For an opacity layer only the region [bx0,bx1) x [by0,by1) (the clip when the layer was pushed) is allocated: px is then
 * offset so absolute coordinates still work, and base is the allocation. */
typedef struct { uint8_t *px, *base; int w, h, bx0, by0, bx1, by1; int tx0, ty0, tx1, ty1; size_t cap; } Surf;   /* tx/ty: bounding box of what the integer rasterizer drew on a layer (the layer is composited only there) */
/* ToUint8Clamp as performed when JavaScript stores into a Uint8ClampedArray (round half to even) */
static inline uint8_t c8(double v) { if (!(v > 0)) { return 0; } if (v >= 255) { return 255; } double f = floor(v); double d = v - f; if (d < 0.5) { return (uint8_t)f; } if (d > 0.5) { return (uint8_t)(f + 1); } return (uint8_t)(((int)f & 1) ? f + 1 : f); }
static inline void blend(uint8_t *px, size_t i, double r, double g, double b, double a) {
	if (a <= 0) { return; }
	if (a >= 1) { px[i] = c8(r); px[i + 1] = c8(g); px[i + 2] = c8(b); px[i + 3] = 255; return; }
	if (px[i + 3] == 255) { double ia = 1 - a; double pr = px[i], pg = px[i + 1], pb = px[i + 2]; px[i] = c8(r * a + pr * ia); px[i + 1] = c8(g * a + pg * ia); px[i + 2] = c8(b * a + pb * ia); return; }
	double da = px[i + 3] / 255.0; double oa = a + da * (1 - a);
	if (oa <= 0) { return; }
	double pr = px[i], pg = px[i + 1], pb = px[i + 2];
	px[i] = c8((r * a + pr * da * (1 - a)) / oa); px[i + 1] = c8((g * a + pg * da * (1 - a)) / oa); px[i + 2] = c8((b * a + pb * da * (1 - a)) / oa); px[i + 3] = c8(oa * 255);
}

/* Layer buffers are pooled: a pooled buffer is all zero (the integer rasterizer clears the part it drew on when it composites a layer), so pushing a layer does not have to clear 2.8 MB. */
#define POOL_N 8
static uint8_t *pool_buf[POOL_N]; static size_t pool_cap[POOL_N]; static int pool_n;
static uint8_t *layer_alloc(size_t bytes, size_t *cap) {
	for (int i = 0; i < pool_n; i++) { if (pool_cap[i] >= bytes) { uint8_t *b = pool_buf[i]; *cap = pool_cap[i]; pool_buf[i] = pool_buf[pool_n - 1]; pool_cap[i] = pool_cap[pool_n - 1]; pool_n--; return b; } }
	*cap = bytes; return (uint8_t *)calloc(bytes, 1);
}
static void layer_release(uint8_t *base, size_t cap, int zeroed) {   /* zeroed: the buffer has been cleared again */
	if (zeroed && pool_n < POOL_N) { pool_buf[pool_n] = base; pool_cap[pool_n] = cap; pool_n++; } else { free(base); }
}
typedef struct { double c[4]; } Clip;
typedef struct { Surf s; Surf layers[16]; int nlayers; Clip clips[256]; int nclips; long rects, glyphs, misses; int integer; } Ctx;
static inline Surf *cur(Ctx *c) { return c->nlayers ? &c->layers[c->nlayers - 1] : &c->s; }

static void fill_rect(Ctx *c, double x, double y, double w, double h, const double *col, double alphaMul) {
	if (col[3] <= 0 || w <= 0 || h <= 0) { return; } c->rects++;
	const double *cl = c->clips[c->nclips - 1].c; double x0 = fmax(cl[0], x), y0 = fmax(cl[1], y), x1 = fmin(cl[2], x + w), y1 = fmin(cl[3], y + h); if (x1 <= x0 || y1 <= y0) { return; }
	Surf *S = cur(c); uint8_t *px = S->px; int W = S->w; double cr = col[0], cg = col[1], cb = col[2], ca = col[3] * alphaMul;
	int fx0 = (int)ceil(x0), fx1 = (int)floor(x1), fy0 = (int)ceil(y0), fy1 = (int)floor(y1);
	if (fx1 > fx0 && fy1 > fy0) {
		if (ca >= 1) { uint8_t r8 = c8(cr), g8 = c8(cg), b8 = c8(cb); for (int yy = fy0; yy < fy1; yy++) { uint8_t *p = px + ((size_t)yy * W + fx0) * 4; for (int xx = fx0; xx < fx1; xx++, p += 4) { p[0] = r8; p[1] = g8; p[2] = b8; p[3] = 255; } } }
		else { for (int yy = fy0; yy < fy1; yy++) { size_t i = ((size_t)yy * W + fx0) * 4; for (int xx = fx0; xx < fx1; xx++, i += 4) { blend(px, i, cr, cg, cb, ca); } } }
	}
	int ix0 = (int)floor(x0), iy0 = (int)floor(y0), ix1 = (int)ceil(x1), iy1 = (int)ceil(y1);
#define EDGE(xa, ya, xb, yb) for (int yy = (ya); yy < (yb); yy++) { double cy = fmin(yy + 1, y1) - fmax(yy, y0); if (cy <= 0) { continue; } for (int xx = (xa); xx < (xb); xx++) { double cx = fmin(xx + 1, x1) - fmax(xx, x0); double cov = cx * cy; if (cov > 0) { blend(px, ((size_t)yy * W + xx) * 4, cr, cg, cb, ca * cov); } } }
	if (fx1 > fx0 && fy1 > fy0) { EDGE(ix0, iy0, ix1, fy0) EDGE(ix0, fy1, ix1, iy1) EDGE(ix0, fy0, fx0, fy1) EDGE(fx1, fy0, ix1, fy1) } else { EDGE(ix0, iy0, ix1, iy1) }
#undef EDGE
}
static void fill_rrect(Ctx *c, double x, double y, double w, double h, const double *radii, const double *col, double alphaMul) {
	if (col[3] <= 0 || w <= 0 || h <= 0) { return; }
	if (!(radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0)) { fill_rect(c, x, y, w, h, col, alphaMul); return; }
	Surf *S = cur(c); const double *cl = c->clips[c->nclips - 1].c; double x0 = fmax(cl[0], x), y0 = fmax(cl[1], y), x1 = fmin(cl[2], x + w), y1 = fmin(cl[3], y + h);
	double rmax = fmin(w, h) / 2; double tl = fmin(radii[0], rmax), tr = fmin(radii[1], rmax), br = fmin(radii[2], rmax), bl = fmin(radii[3], rmax);
	for (int yy = (int)floor(y0); yy < (int)ceil(y1); yy++) for (int xx = (int)floor(x0); xx < (int)ceil(x1); xx++) {
		double cxp = xx + 0.5, cyp = yy + 0.5, r = 0, ox = 0, oy = 0;
		if (cxp < x + tl && cyp < y + tl) { r = tl; ox = x + tl; oy = y + tl; } else if (cxp > x + w - tr && cyp < y + tr) { r = tr; ox = x + w - tr; oy = y + tr; } else if (cxp > x + w - br && cyp > y + h - br) { r = br; ox = x + w - br; oy = y + h - br; } else if (cxp < x + bl && cyp > y + h - bl) { r = bl; ox = x + bl; oy = y + h - bl; }
		double cov = 1; if (r > 0) { double d = hypot(cxp - ox, cyp - oy); cov = fmax(0, fmin(1, r - d + 0.5)); }
		double ex = fmin(xx + 1, x1) - fmax(xx, x0), ey = fmin(yy + 1, y1) - fmax(yy, y0); cov *= ex * ey; if (cov > 0) { blend(S->px, ((size_t)yy * S->w + xx) * 4, col[0], col[1], col[2], col[3] * alphaMul * cov); }
	}
}
static void glyph_run(Ctx *c, int fontId, double size, double ls, double wsp, double x, double by, const double *col, double alphaMul, int n, const double *cps) {
	Font *f = &fonts[fontId]; Surf *S = cur(c); const double *cl = c->clips[c->nclips - 1].c; double prev = 0;
	for (int i = 0; i < n; i++) {
		uint32_t cp = (uint32_t)cps[i]; Slot *os = map_find(&f->outlines, cp, 0); double adv = (os ? ((Outline *)os->v.p)->adv : 0) * size;
		if (ls == 0 && prev) { Slot *ks = map_find(&f->kerns, ((uint64_t)(uint32_t)prev << 32) | cp, 0); if (ks) { x += ks->v.d * size; } }
		prev = cp;
		if (cp != 32 && cp != 160 && cp != 9) {
			int fxq = (int)js_round((x - floor(x)) * 4); Glyph *g = get_glyph(f, fontId, cp, size, fxq, &c->misses); c->glyphs++;
			if (!g->empty) {
				int gx = (int)floor(x) + g->left, gy = (int)by + g->top;
				for (int yy = 0; yy < g->h; yy++) { int py = gy + yy; if (py < cl[1] || py >= cl[3]) { continue; } for (int xx = 0; xx < g->w; xx++) { int pxx = gx + xx; if (pxx < cl[0] || pxx >= cl[2]) { continue; } int cv = g->cov[(size_t)yy * g->w + xx]; if (cv) { cv = GAMMA[cv]; blend(S->px, ((size_t)py * S->w + pxx) * 4, col[0], col[1], col[2], col[3] * alphaMul * cv / 255); } } }
			}
		}
		x += adv + ls + (cp == 32 ? wsp : 0);
	}
}

#include "raster_int.h"
#include "svg98.h"

/* ---------------------------------------------------------------- command stream */
enum { OP_FILL_RECT = 1, OP_FILL_RRECT, OP_PUSH_CLIP, OP_POP_CLIP, OP_PUSH_LAYER, OP_POP_LAYER, OP_GLYPH_RUN, OP_RESET_CLIP, OP_DRAW_IMAGE };
/* ---- images: registered once by JavaScript (straight-alpha RGBA), drawn scaled with bilinear sampling (16.16 fixed point), clipped, composited like a rectangle of per-pixel alpha */
static int get_u8(JSContext *ctx, JSValueConst v, uint8_t **out, size_t *count);
typedef struct { int w, h; uint8_t *rgba; } Image;
#define MAX_IMAGES 4096
static Image images[MAX_IMAGES];
static void draw_image(Ctx *c, int id, double x, double y, double w, double h, double alphaMul) {
	if (id <= 0 || id >= MAX_IMAGES || !images[id].rgba || w <= 0 || h <= 0) { return; } const Image *im = &images[id]; const double *cl = c->clips[c->nclips - 1].c;
	int x0 = (int)fmax(cl[0], floor(x + 0.5)), y0 = (int)fmax(cl[1], floor(y + 0.5)), x1 = (int)fmin(cl[2], floor(x + w + 0.5)), y1 = (int)fmin(cl[3], floor(y + h + 0.5)); Surf *S = cur(c);
	if (x0 < S->bx0) { x0 = S->bx0; } if (y0 < S->by0) { y0 = S->by0; } if (x1 > S->bx1) { x1 = S->bx1; } if (y1 > S->by1) { y1 = S->by1; } if (x1 <= x0 || y1 <= y0) { return; }
	touch(S, x0, y0, x1, y1); int am = (int)(alphaMul * 256 + 0.5); if (am > 256) { am = 256; } double sx = im->w / w, sy = im->h / h;
	for (int yy = y0; yy < y1; yy++) {
		double fy = (yy + 0.5 - y) * sy - 0.5; if (fy < 0) { fy = 0; } if (fy > im->h - 1) { fy = im->h - 1; } int iy = (int)fy, iy2 = iy + 1 < im->h ? iy + 1 : iy; int ty = (int)((fy - iy) * 256); uint8_t *row = S->px + (size_t)yy * S->w * 4;
		for (int xx = x0; xx < x1; xx++) {
			double fx = (xx + 0.5 - x) * sx - 0.5; if (fx < 0) { fx = 0; } if (fx > im->w - 1) { fx = im->w - 1; } int ix = (int)fx, ix2 = ix + 1 < im->w ? ix + 1 : ix; int tx = (int)((fx - ix) * 256);
			const uint8_t *p00 = im->rgba + ((size_t)iy * im->w + ix) * 4, *p10 = im->rgba + ((size_t)iy * im->w + ix2) * 4, *p01 = im->rgba + ((size_t)iy2 * im->w + ix) * 4, *p11 = im->rgba + ((size_t)iy2 * im->w + ix2) * 4;
			int w00 = (256 - tx) * (256 - ty), w10 = tx * (256 - ty), w01 = (256 - tx) * ty, w11 = tx * ty;   /* sum 65536 */
			int a00 = p00[3] * w00, a10 = p10[3] * w10, a01 = p01[3] * w01, a11 = p11[3] * w11; int asum = a00 + a10 + a01 + a11; if (asum <= 0) { continue; }
			int r = (int)(((int64_t)p00[0] * a00 + (int64_t)p10[0] * a10 + (int64_t)p01[0] * a01 + (int64_t)p11[0] * a11) / asum), g = (int)(((int64_t)p00[1] * a00 + (int64_t)p10[1] * a10 + (int64_t)p01[1] * a01 + (int64_t)p11[1] * a11) / asum), b = (int)(((int64_t)p00[2] * a00 + (int64_t)p10[2] * a10 + (int64_t)p01[2] * a01 + (int64_t)p11[2] * a11) / asum);
			int a = (int)(((int64_t)asum * am) >> 24); if (a > 255) { a = 255; } blend_i(row + (size_t)xx * 4, r, g, b, a);
		}
	}
}
static JSValue js_register_image(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	int id, w, h; JS_ToInt32(ctx, &id, argv[0]); JS_ToInt32(ctx, &w, argv[1]); JS_ToInt32(ctx, &h, argv[2]); uint8_t *p; size_t n; if (get_u8(ctx, argv[3], &p, &n) < 0 || n < (size_t)w * h * 4) { return JS_ThrowTypeError(ctx, "RGBA Uint8Array expected"); }
	if (id <= 0 || id >= MAX_IMAGES) { return JS_ThrowRangeError(ctx, "image id"); } free(images[id].rgba); images[id].w = w; images[id].h = h; images[id].rgba = (uint8_t *)malloc((size_t)w * h * 4); memcpy(images[id].rgba, p, (size_t)w * h * 4); return JS_UNDEFINED;
}
static JSValue js_free_image(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { int id; JS_ToInt32(ctx, &id, argv[0]); if (id > 0 && id < MAX_IMAGES) { free(images[id].rgba); images[id].rgba = NULL; } return JS_UNDEFINED; }
static int get_f64(JSContext *ctx, JSValueConst v, double **out, size_t *count) {
	size_t off, len, bpe; JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe); if (JS_IsException(buf)) { return -1; }
	size_t sz; uint8_t *p = JS_GetArrayBuffer(ctx, &sz, buf); JS_FreeValue(ctx, buf); if (!p) { return -1; }
	*out = (double *)(p + off); *count = len / sizeof(double); return 0;
}
static int get_u8(JSContext *ctx, JSValueConst v, uint8_t **out, size_t *count) {
	size_t off, len, bpe; JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe); if (JS_IsException(buf)) { return -1; }
	size_t sz; uint8_t *p = JS_GetArrayBuffer(ctx, &sz, buf); JS_FreeValue(ctx, buf); if (!p) { return -1; }
	*out = p + off; *count = len; return 0;
}
/* registerFont(upm, ascenderEm, descenderEm, lineGapEm) -> id */
static JSValue js_register_font(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	double upm, asc = 0, desc = 0, gap = 0; JS_ToFloat64(ctx, &upm, argv[0]); if (argc > 1) { JS_ToFloat64(ctx, &asc, argv[1]); JS_ToFloat64(ctx, &desc, argv[2]); JS_ToFloat64(ctx, &gap, argv[3]); }
	if (nfonts >= 256) { return JS_ThrowRangeError(ctx, "too many fonts"); }
	memset(&fonts[nfonts], 0, sizeof(Font)); fonts[nfonts].upm = upm; fonts[nfonts].asc = asc; fonts[nfonts].desc = desc; fonts[nfonts].gap = gap; return JS_NewInt32(ctx, nfonts++);
}
static Outline *get_outline(int id, uint32_t cp) { Slot *s = map_find(&fonts[id].outlines, cp, 1); if (!s->v.p) { s->v.p = calloc(1, sizeof(Outline)); } return (Outline *)s->v.p; }
/* provideAdvance(fontId, cp, advanceEm) */
static JSValue js_provide_advance(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	int id; uint32_t cp; double adv; JS_ToInt32(ctx, &id, argv[0]); JS_ToUint32(ctx, &cp, argv[1]); JS_ToFloat64(ctx, &adv, argv[2]); get_outline(id, cp)->adv = adv; return JS_UNDEFINED;
}
/* provideOutline(fontId, cp, Float64Array commands): groups of 7 doubles {type,x,y,x1,y1,x2,y2} in font units */
static JSValue js_provide_outline(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	int id; uint32_t cp; JS_ToInt32(ctx, &id, argv[0]); JS_ToUint32(ctx, &cp, argv[1]);
	double *cmd = NULL; size_t n = 0; if (get_f64(ctx, argv[2], &cmd, &n) < 0) { return JS_EXCEPTION; }
	Outline *o = get_outline(id, cp); free(o->cmd); o->cmd = NULL; o->ncmd = (int)(n / 7); if (n) { o->cmd = (double *)malloc(n * sizeof(double)); memcpy(o->cmd, cmd, n * sizeof(double)); } return JS_UNDEFINED;
}
/* provideKern(fontId, a, b, valueEm) */
static JSValue js_provide_kern(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	int id; uint32_t a, b; double v; JS_ToInt32(ctx, &id, argv[0]); JS_ToUint32(ctx, &a, argv[1]); JS_ToUint32(ctx, &b, argv[2]); JS_ToFloat64(ctx, &v, argv[3]);
	Slot *s = map_find(&fonts[id].kerns, ((uint64_t)a << 32) | b, 1); s->v.d = v; return JS_UNDEFINED;
}
static JSValue js_set_gamma(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	uint8_t *p; size_t n; if (get_u8(ctx, argv[0], &p, &n) < 0 || n < 256) { return JS_ThrowTypeError(ctx, "Uint8Array(256) expected"); } memcpy(GAMMA, p, 256); gamma_init = 1; return JS_UNDEFINED;
}
/* execute(Uint8ClampedArray pixels, width, height, Float64Array commands, count) -> { rects, glyphs, glyphMisses } */
static JSValue js_execute(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
	uint8_t *px; size_t pn; if (get_u8(ctx, argv[0], &px, &pn) < 0) { return JS_EXCEPTION; }
	int w, h, count; JS_ToInt32(ctx, &w, argv[1]); JS_ToInt32(ctx, &h, argv[2]); JS_ToInt32(ctx, &count, argv[4]);
	double *cmd; size_t cn; if (get_f64(ctx, argv[3], &cmd, &cn) < 0) { return JS_EXCEPTION; }
	if (pn < (size_t)w * h * 4 || (size_t)count > cn) { return JS_ThrowRangeError(ctx, "buffer too small"); }
	if (!gamma_init) { for (int i = 0; i < 256; i++) { GAMMA[i] = (uint8_t)i; } gamma_init = 1; }
	int mode = 0; if (argc > 5) { JS_ToInt32(ctx, &mode, argv[5]); } int prof = (mode & 2) != 0; mode &= 1; double opNs[16] = { 0 }; long opN[16] = { 0 }; struct timespec ts0, ts1;
	Ctx *c = (Ctx *)calloc(1, sizeof(Ctx)); c->integer = mode == 1; c->s.px = px; c->s.w = w; c->s.h = h; c->s.bx0 = 0; c->s.by0 = 0; c->s.bx1 = w; c->s.by1 = h; c->nclips = 1; c->clips[0].c[0] = 0; c->clips[0].c[1] = 0; c->clips[0].c[2] = w; c->clips[0].c[3] = h;
	for (int i = 0; i < count;) {
		int op = (int)cmd[i++]; if (prof) { prof_now(&ts0); }
		switch (op) {
		case OP_FILL_RECT: (c->integer ? fill_rect_i : fill_rect)(c, cmd[i], cmd[i + 1], cmd[i + 2], cmd[i + 3], &cmd[i + 4], cmd[i + 8]); i += 9; break;
		case OP_FILL_RRECT: (c->integer ? fill_rrect_i : fill_rrect)(c, cmd[i], cmd[i + 1], cmd[i + 2], cmd[i + 3], &cmd[i + 4], &cmd[i + 8], cmd[i + 12]); i += 13; break;
		case OP_PUSH_CLIP: { const double *p = c->clips[c->nclips - 1].c; Clip n; n.c[0] = fmax(p[0], cmd[i]); n.c[1] = fmax(p[1], cmd[i + 1]); n.c[2] = fmin(p[2], cmd[i + 2]); n.c[3] = fmin(p[3], cmd[i + 3]); if (c->nclips < 256) { c->clips[c->nclips++] = n; } i += 4; break; }
		case OP_POP_CLIP: if (c->nclips > 1) { c->nclips--; } break;
		case OP_RESET_CLIP: { Surf *RS = cur(c); Clip n; n.c[0] = RS->bx0; n.c[1] = RS->by0; n.c[2] = RS->bx1; n.c[3] = RS->by1;   /* the whole surface (a layer's region when inside one) */ if (c->nclips < 256) { c->clips[c->nclips++] = n; } break; }   /* a clip that ignores the ones below it (position:fixed) */
		case OP_PUSH_LAYER: if (c->nlayers < 16) { const double *cp = c->clips[c->nclips - 1].c; Surf *P = cur(c); int bx0 = (int)floor(cp[0]), by0 = (int)floor(cp[1]), bx1 = (int)ceil(cp[2]), by1 = (int)ceil(cp[3]); if (bx0 < 0) { bx0 = 0; } if (by0 < 0) { by0 = 0; } if (bx1 > w) { bx1 = w; } if (by1 > h) { by1 = h; } if (bx1 < bx0) { bx1 = bx0; } if (by1 < by0) { by1 = by0; } (void)P;
			Surf *L = &c->layers[c->nlayers++]; int rw = bx1 - bx0, rh = by1 - by0; L->base = layer_alloc((size_t)(rw ? rw : 1) * (rh ? rh : 1) * 4, &L->cap); L->w = rw; L->h = rh; L->bx0 = bx0; L->by0 = by0; L->bx1 = bx1; L->by1 = by1; L->tx0 = bx1; L->ty0 = by1; L->tx1 = bx0; L->ty1 = by0; L->px = L->base - ((size_t)by0 * rw + bx0) * 4; } break;
		case OP_POP_LAYER: { double alpha = cmd[i++]; if (c->integer) { pop_layer_i(c, alpha); break; } if (c->nlayers) { Surf sub = c->layers[--c->nlayers]; Surf *d = cur(c); for (int yy = sub.by0; yy < sub.by1; yy++) { for (int xx = sub.bx0; xx < sub.bx1; xx++) { const uint8_t *sp = sub.px + ((size_t)yy * sub.w + xx) * 4; if (sp[3]) { blend(d->px, ((size_t)yy * d->w + xx) * 4, sp[0], sp[1], sp[2], sp[3] / 255.0 * alpha); } } } free(sub.base); } break; }
		case OP_GLYPH_RUN: { int fid = (int)cmd[i]; int n = (int)cmd[i + 11]; (c->integer ? glyph_run_i : glyph_run)(c, fid, cmd[i + 1], cmd[i + 2], cmd[i + 3], cmd[i + 4], cmd[i + 5], &cmd[i + 6], cmd[i + 10], n, &cmd[i + 12]); i += 12 + n; break; }
		case OP_DRAW_IMAGE: draw_image(c, (int)cmd[i], cmd[i + 1], cmd[i + 2], cmd[i + 3], cmd[i + 4], cmd[i + 5]); i += 6; break;
		default: free(c); return JS_ThrowRangeError(ctx, "bad opcode %d at %d", op, i - 1);
		}
		if (prof) { prof_now(&ts1); opNs[op] += (ts1.tv_sec - ts0.tv_sec) * 1e9 + (ts1.tv_nsec - ts0.tv_nsec); opN[op]++; }
	}
	JSValue r = JS_NewObject(ctx); JS_SetPropertyStr(ctx, r, "rects", JS_NewInt32(ctx, (int)c->rects)); JS_SetPropertyStr(ctx, r, "glyphs", JS_NewInt32(ctx, (int)c->glyphs)); JS_SetPropertyStr(ctx, r, "glyphMisses", JS_NewInt32(ctx, (int)c->misses));
	if (prof) { static const char *names[] = { "", "fillRect", "fillRoundRect", "pushClip", "popClip", "pushLayer", "popLayer", "glyphRun" }; JSValue o = JS_NewObject(ctx); for (int k = 1; k < 8; k++) { JSValue e = JS_NewObject(ctx); JS_SetPropertyStr(ctx, e, "ms", JS_NewFloat64(ctx, opNs[k] / 1e6)); JS_SetPropertyStr(ctx, e, "n", JS_NewInt32(ctx, (int)opN[k])); JS_SetPropertyStr(ctx, o, names[k], e); } JS_SetPropertyStr(ctx, r, "profile", o); }
	while (c->nlayers) { free(c->layers[--c->nlayers].base); } free(c); return r;
}

static const JSCFunctionListEntry funcs[] = {
	JS_CFUNC_DEF("registerFont", 4, js_register_font), JS_CFUNC_DEF("provideAdvance", 3, js_provide_advance), JS_CFUNC_DEF("provideOutline", 3, js_provide_outline), JS_CFUNC_DEF("provideKern", 4, js_provide_kern),
	JS_CFUNC_DEF("setGamma", 1, js_set_gamma), JS_CFUNC_DEF("execute", 6, js_execute), JS_CFUNC_DEF("registerImage", 4, js_register_image), JS_CFUNC_DEF("freeImage", 1, js_free_image),
};
static int render_init(JSContext *ctx, JSModuleDef *m) { return JS_SetModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
/* x87: make doubles behave as IEEE doubles (53-bit mantissa) instead of 80-bit extended, as ECMAScript requires and as SSE2 does */
#if defined(__i386__) || defined(_M_IX86)
#if defined(_WIN32)
#include <float.h>
static void set_fpu_double(void) { _controlfp(_PC_53, _MCW_PC); }
#else
#include <fpu_control.h>
static void set_fpu_double(void) { fpu_control_t cw; _FPU_GETCW(cw); cw = (cw & ~_FPU_EXTENDED) | _FPU_DOUBLE; _FPU_SETCW(cw); }
#endif
#else
static void set_fpu_double(void) { }
#endif
/* Browsers log an unhandled promise rejection and carry on; stock QuickJS exits with status 1. Route rejections to globalThis.__rejection(promise, reason, handled) when it exists. */
static void rejection_tracker(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool is_handled, void *opaque) {
	JSValue g = JS_GetGlobalObject(ctx); JSValue fn = JS_GetPropertyStr(ctx, g, "__rejection");
	if (JS_IsFunction(ctx, fn)) { JSValue args[3] = { promise, reason, JS_NewBool(ctx, is_handled) }; JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 3, args); JS_FreeValue(ctx, r); }
	else if (!is_handled) { fprintf(stderr, "Unhandled promise rejection: "); JSValue str = JS_ToString(ctx, reason); const char *c = JS_ToCString(ctx, str); fprintf(stderr, "%s\n", c ? c : "?"); JS_FreeCString(ctx, c); JS_FreeValue(ctx, str); }
	JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
}
void spike_install_rejection_tracker(JSRuntime *rt) { JS_SetHostPromiseRejectionTracker(rt, rejection_tracker, NULL); }
void spike_init_render(JSContext *ctx) { set_fpu_double(); js98_svg_install(ctx); JSModuleDef *m = JS_NewCModule(ctx, "spike:render", render_init); if (m) { JS_AddModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); } }

/* accessors for layout.c */
int render_font_metrics(int id, double *asc, double *desc, double *gap) { if (id < 0 || id >= nfonts) { return 0; } *asc = fonts[id].asc; *desc = fonts[id].desc; *gap = fonts[id].gap; return 1; }
double render_advance_em(int id, uint32_t cp) { Slot *s = map_find(&fonts[id].outlines, cp, 0); return s ? ((Outline *)s->v.p)->adv : 0; }
double render_kern_em(int id, uint32_t a, uint32_t b) { Slot *s = map_find(&fonts[id].kerns, ((uint64_t)a << 32) | b, 0); return s ? s->v.d : 0; }
