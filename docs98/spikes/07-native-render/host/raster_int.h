/* Integer rasterizer: the same drawing operations as the exact (double) rasterizer in render.c, but with no floating point in any per-pixel or per-edge loop.
 * Colors and alphas are 8-bit, coverage is 0..256 fixed point, pixel-space geometry is 24.8, glyph outlines are flattened and scan-converted in 16.16 with
 * 64-bit intermediates, rounded-corner distances use an integer square root. Floating point is used only once per operation (clip/position/alpha conversion)
 * and once per glyph (advance and sub-pixel position, so glyphs land exactly where the exact rasterizer puts them). This is what an x87-only CPU (no SSE2)
 * wants: the exact path costs ~6x more there. Output differs from the exact path by rounding only (see tests/pixel_tolerance.py). Included by render.c. */

#if !defined(__BYTE_ORDER__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "raster_int.h assumes a little-endian target (x86)"
#endif
static inline int i_min(int a, int b) { return a < b ? a : b; }
static inline int i_max(int a, int b) { return a > b ? a : b; }
static inline int div255(int x) { x += 128; return (x + (x >> 8)) >> 8; }   /* round(x / 255) for 0 <= x <= 65025 */
static inline int q8(double v) { return v <= 0 ? 0 : v >= 255 ? 255 : (int)(v + 0.5); }
static inline int qa(double a) { return a <= 0 ? 0 : a >= 1 ? 255 : (int)(a * 255 + 0.5); }
static inline int fx8(double v) { return (int)(v * 256 + (v >= 0 ? 0.5 : -0.5)); }   /* to 24.8 */

/* blend (r,g,b) with 8-bit alpha a over the RGBA pixel p */
static inline void blend_i(uint8_t *p, int r, int g, int b, int a) {
	if (a <= 0) { return; }
	if (a >= 255) { p[0] = (uint8_t)r; p[1] = (uint8_t)g; p[2] = (uint8_t)b; p[3] = 255; return; }
	if (p[3] == 255) { int ia = 255 - a; p[0] = (uint8_t)div255(r * a + p[0] * ia); p[1] = (uint8_t)div255(g * a + p[1] * ia); p[2] = (uint8_t)div255(b * a + p[2] * ia); return; }
	{ int da = p[3]; int w = div255(da * (255 - a)); int oa = a + w; if (oa <= 0) { return; } int den = oa * 255, half = den >> 1;
	  p[0] = (uint8_t)((r * a * 255 + p[0] * da * (255 - a) + half) / den); p[1] = (uint8_t)((g * a * 255 + p[1] * da * (255 - a) + half) / den); p[2] = (uint8_t)((b * a * 255 + p[2] * da * (255 - a) + half) / den); p[3] = (uint8_t)oa; }
}
static inline void span_i(uint8_t *row, int xs, int xe, int r, int g, int b, int a) {   /* constant-alpha span [xs, xe) */
	if (a <= 0 || xe <= xs) { return; }
	if (a >= 255) { uint32_t pix = (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u; uint32_t *p = (uint32_t *)(row + (size_t)xs * 4); for (int x = xs; x < xe; x++) { *p++ = pix; } return; }
	for (int x = xs; x < xe; x++) { blend_i(row + (size_t)x * 4, r, g, b, a); }
}

static void fill_rect_i(Ctx *c, double x, double y, double w, double h, const double *col, double alphaMul) {
	if (col[3] <= 0 || w <= 0 || h <= 0) { return; } c->rects++;
	const double *cl = c->clips[c->nclips - 1].c; double x0 = fmax(cl[0], x), y0 = fmax(cl[1], y), x1 = fmin(cl[2], x + w), y1 = fmin(cl[3], y + h); if (x1 <= x0 || y1 <= y0) { return; }
	int a8 = qa(col[3] * alphaMul); if (a8 <= 0) { return; } int r = q8(col[0]), g = q8(col[1]), b = q8(col[2]);
	int x0f = fx8(x0), y0f = fx8(y0), x1f = fx8(x1), y1f = fx8(y1); Surf *S = cur(c); int W = S->w;
	int ix0 = x0f >> 8, iy0 = y0f >> 8, ix1 = (x1f + 255) >> 8, iy1 = (y1f + 255) >> 8, fx0 = (x0f + 255) >> 8, fx1 = x1f >> 8;
	if (ix1 > S->bx1) { ix1 = S->bx1; } if (iy1 > S->by1) { iy1 = S->by1; } if (fx1 > ix1) { fx1 = ix1; }
	for (int yy = iy0; yy < iy1; yy++) {
		int cy = i_min((yy + 1) << 8, y1f) - i_max(yy << 8, y0f); if (cy <= 0) { continue; } uint8_t *row = S->px + (size_t)yy * W * 4;
		if (fx1 > fx0) {
			for (int xx = ix0; xx < fx0; xx++) { int cx = i_min((xx + 1) << 8, x1f) - i_max(xx << 8, x0f); blend_i(row + (size_t)xx * 4, r, g, b, (a8 * ((cx * cy) >> 8)) >> 8); }
			span_i(row, fx0, fx1, r, g, b, cy == 256 ? a8 : (a8 * cy) >> 8);
			for (int xx = fx1; xx < ix1; xx++) { int cx = i_min((xx + 1) << 8, x1f) - i_max(xx << 8, x0f); blend_i(row + (size_t)xx * 4, r, g, b, (a8 * ((cx * cy) >> 8)) >> 8); }
		} else {
			for (int xx = ix0; xx < ix1; xx++) { int cx = i_min((xx + 1) << 8, x1f) - i_max(xx << 8, x0f); if (cx > 0) { blend_i(row + (size_t)xx * 4, r, g, b, (a8 * ((cx * cy) >> 8)) >> 8); } }
		}
	}
}
static uint32_t isqrt64(uint64_t n) {
	if (n < 0xFFFFFFFFu) { uint32_t v = (uint32_t)n, r = 0, bit = 1u << 30; while (bit > v) { bit >>= 2; } while (bit) { if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; } else { r >>= 1; } bit >>= 2; } return r; }
	{ uint64_t v = n, r = 0, bit = 1ULL << 62; while (bit > v) { bit >>= 2; } while (bit) { if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; } else { r >>= 1; } bit >>= 2; } return (uint32_t)r; }
}
static void fill_rrect_i(Ctx *c, double x, double y, double w, double h, const double *radii, const double *col, double alphaMul) {
	if (col[3] <= 0 || w <= 0 || h <= 0) { return; }
	if (!(radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0)) { fill_rect_i(c, x, y, w, h, col, alphaMul); return; }
	Surf *S = cur(c); const double *cl = c->clips[c->nclips - 1].c; double x0 = fmax(cl[0], x), y0 = fmax(cl[1], y), x1 = fmin(cl[2], x + w), y1 = fmin(cl[3], y + h);
	int a8 = qa(col[3] * alphaMul); if (a8 <= 0 || x1 <= x0 || y1 <= y0) { return; } int r8 = q8(col[0]), g8 = q8(col[1]), b8 = q8(col[2]);
	double rmax = fmin(w, h) / 2; int tl = fx8(fmin(radii[0], rmax)), tr = fx8(fmin(radii[1], rmax)), br = fx8(fmin(radii[2], rmax)), bl = fx8(fmin(radii[3], rmax));
	int XL = fx8(x), XR = fx8(x + w), YT = fx8(y), YB = fx8(y + h); int x0f = fx8(x0), y0f = fx8(y0), x1f = fx8(x1), y1f = fx8(y1); int W = S->w;
	int ix0 = x0f >> 8, iy0 = y0f >> 8, ix1 = (x1f + 255) >> 8, iy1 = (y1f + 255) >> 8; if (ix1 > S->bx1) { ix1 = S->bx1; } if (iy1 > S->by1) { iy1 = S->by1; }
	int topR = i_max(tl, tr), botR = i_max(bl, br);
	for (int yy = iy0; yy < iy1; yy++) {
		int ey = i_min((yy + 1) << 8, y1f) - i_max(yy << 8, y0f); if (ey <= 0) { continue; } int cyp = (yy << 8) + 128; uint8_t *row = S->px + (size_t)yy * W * 4;
		int plain = cyp >= YT + topR && cyp <= YB - botR;   /* no corner reaches this row: only the left/right edge columns have partial coverage */
		if (plain) {
			int fx0 = (x0f + 255) >> 8, fx1 = i_min(x1f >> 8, ix1);
			if (fx1 > fx0) {
				for (int xx = ix0; xx < fx0; xx++) { int ex = i_min((xx + 1) << 8, x1f) - i_max(xx << 8, x0f); blend_i(row + (size_t)xx * 4, r8, g8, b8, (a8 * ((ex * ey) >> 8)) >> 8); }
				span_i(row, fx0, fx1, r8, g8, b8, ey == 256 ? a8 : (a8 * ey) >> 8);
				for (int xx = fx1; xx < ix1; xx++) { int ex = i_min((xx + 1) << 8, x1f) - i_max(xx << 8, x0f); blend_i(row + (size_t)xx * 4, r8, g8, b8, (a8 * ((ex * ey) >> 8)) >> 8); }
				continue;
			}
		}
		for (int xx = ix0; xx < ix1; xx++) {
			int ex = i_min((xx + 1) << 8, x1f) - i_max(xx << 8, x0f); if (ex <= 0) { continue; }
			int cxp = (xx << 8) + 128, rr = 0, ox = 0, oy = 0;
			if (cxp < XL + tl && cyp < YT + tl) { rr = tl; ox = XL + tl; oy = YT + tl; } else if (cxp > XR - tr && cyp < YT + tr) { rr = tr; ox = XR - tr; oy = YT + tr; } else if (cxp > XR - br && cyp > YB - br) { rr = br; ox = XR - br; oy = YB - br; } else if (cxp < XL + bl && cyp > YB - bl) { rr = bl; ox = XL + bl; oy = YB - bl; }
			int cov = 256; if (rr > 0) { int dx = cxp - ox, dy = cyp - oy; uint32_t d = isqrt64((uint64_t)((int64_t)dx * dx + (int64_t)dy * dy)); int v = rr - (int)d + 128; cov = v < 0 ? 0 : v > 256 ? 256 : v; }
			cov = (cov * ex) >> 8; cov = (cov * ey) >> 8; if (cov > 0) { blend_i(row + (size_t)xx * 4, r8, g8, b8, (a8 * cov) >> 8); }
		}
	}
}

/* ---- glyph coverage in fixed point */
typedef struct { int x0, y0, x1, y1, dir; int64_t dxdy; } IEdge;
typedef struct { IEdge *e; int n, cap; } IEdges;
static void ie_line(IEdges *E, int x0, int y0, int x1, int y1) {
	if (y0 == y1) { return; }
	if (E->n == E->cap) { E->cap = E->cap ? E->cap * 2 : 64; E->e = (IEdge *)realloc(E->e, E->cap * sizeof(IEdge)); }
	IEdge *e = &E->e[E->n++]; e->x0 = x0; e->y0 = y0; e->x1 = x1; e->y1 = y1; e->dir = 0; e->dxdy = 0;
}
static void ie_quad(IEdges *E, int x0, int y0, int x1, int y1, int x2, int y2) {
	int px = x0, py = y0;
	for (int i = 1; i <= 8; i++) { int u = 8 - i; int x = (int)(((int64_t)u * u * x0 + (int64_t)2 * u * i * x1 + (int64_t)i * i * x2) / 64), y = (int)(((int64_t)u * u * y0 + (int64_t)2 * u * i * y1 + (int64_t)i * i * y2) / 64); ie_line(E, px, py, x, y); px = x; py = y; }
}
static void ie_cubic(IEdges *E, int x0, int y0, int x1, int y1, int x2, int y2, int x3, int y3) {
	int px = x0, py = y0;
	for (int i = 1; i <= 10; i++) { int u = 10 - i; int64_t b0 = (int64_t)u * u * u, b1 = (int64_t)3 * u * u * i, b2 = (int64_t)3 * u * i * i, b3 = (int64_t)i * i * i;
		int x = (int)((b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3) / 1000), y = (int)((b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3) / 1000); ie_line(E, px, py, x, y); px = x; py = y; }
}
static inline int to_fx16(int v16, int64_t S) { return (int)(((int64_t)v16 * S) >> 8); }   /* v16: font units x16; S = size/upm x 2^20  ->  16.16 pixels */
static Glyph *get_glyph_i(Font *f, uint32_t cp, double size, int fxq, long *misses) {
	uint64_t key = (uint64_t)cp | ((uint64_t)fxq << 21) | ((uint64_t)size_index(size) << 24);
	Slot *sl = map_find(&f->iglyphs, key, 0); if (sl) { return (Glyph *)sl->v.p; }
	(*misses)++; Glyph *g = (Glyph *)calloc(1, sizeof(Glyph)); sl = map_find(&f->iglyphs, key, 1); sl->v.p = g;
	Slot *os = map_find(&f->outlines, cp, 0); if (!os) { g->empty = 1; return g; }
	Outline *o = (Outline *)os->v.p; int64_t S = (int64_t)(size / f->upm * 1048576.0 + 0.5); int fx = fxq * 16384;
	IEdges E = { 0, 0, 0 }; int sx = 0, sy = 0, cx = 0, cy = 0;
	for (int i = 0; i < o->ncmd; i++) {
		const double *k = &o->cmd[i * 7]; int type = (int)k[0];
#define V16(d) ((int)((d) * 16 + ((d) >= 0 ? 0.5 : -0.5)))
		int X = fx + to_fx16(V16(k[1]), S), Y = -to_fx16(V16(k[2]), S), X1 = fx + to_fx16(V16(k[3]), S), Y1 = -to_fx16(V16(k[4]), S), X2 = fx + to_fx16(V16(k[5]), S), Y2 = -to_fx16(V16(k[6]), S);
#undef V16
		switch (type) {
		case 0: if (cx != sx || cy != sy) { ie_line(&E, cx, cy, sx, sy); } sx = cx = X; sy = cy = Y; break;
		case 1: ie_line(&E, cx, cy, X, Y); cx = X; cy = Y; break;
		case 2: ie_quad(&E, cx, cy, X1, Y1, X, Y); cx = X; cy = Y; break;
		case 3: ie_cubic(&E, cx, cy, X1, Y1, X2, Y2, X, Y); cx = X; cy = Y; break;
		case 4: ie_line(&E, cx, cy, sx, sy); cx = sx; cy = sy; break;
		}
	}
	if (cx != sx || cy != sy) { ie_line(&E, cx, cy, sx, sy); }
	if (!E.n) { g->empty = 1; free(E.e); return g; }
	int minX = E.e[0].x0, maxX = minX, minY = E.e[0].y0, maxY = minY;
	for (int i = 0; i < E.n; i++) { IEdge *e = &E.e[i]; minX = i_min(minX, i_min(e->x0, e->x1)); maxX = i_max(maxX, i_max(e->x0, e->x1)); minY = i_min(minY, i_min(e->y0, e->y1)); maxY = i_max(maxY, i_max(e->y0, e->y1)); }
	int left = (minX >> 16) - 1, top = (minY >> 16) - 1, w = ((maxX + 65535) >> 16) + 1 - left, h = ((maxY + 65535) >> 16) + 1 - top;
	for (int i = 0; i < E.n; i++) {
		IEdge *e = &E.e[i]; int ax = e->x0, ay = e->y0, bx = e->x1, by = e->y1;
		if (ay < by) { e->x0 = ax - (left << 16); e->y0 = ay - (top << 16); e->x1 = bx - (left << 16); e->y1 = by - (top << 16); e->dir = 1; } else { e->x0 = bx - (left << 16); e->y0 = by - (top << 16); e->x1 = ax - (left << 16); e->y1 = ay - (top << 16); e->dir = -1; }
		e->dxdy = (((int64_t)(e->x1 - e->x0)) << 16) / (e->y1 - e->y0);
	}
	uint8_t *cov = (uint8_t *)calloc((size_t)w * h, 1); uint32_t *acc = (uint32_t *)calloc((size_t)w + 1, sizeof(uint32_t)); int *xs = (int *)malloc(sizeof(int) * 2 * (E.n + 1)); const int64_t wmax = (int64_t)w << 16;
	for (int y = 0; y < h; y++) {
		memset(acc, 0, ((size_t)w + 1) * sizeof(uint32_t));
		for (int s = 0; s < 4; s++) {
			int ys = (y << 16) + (2 * s + 1) * 8192; int nx = 0;
			for (int i = 0; i < E.n; i++) { IEdge *e = &E.e[i]; if (ys >= e->y0 && ys < e->y1) { xs[nx * 2] = e->x0 + (int)(((int64_t)(ys - e->y0) * e->dxdy) >> 16); xs[nx * 2 + 1] = e->dir; nx++; } }
			if (nx < 2) { continue; }
			for (int i = 1; i < nx; i++) { int kx = xs[i * 2], kd = xs[i * 2 + 1]; int j = i - 1; while (j >= 0 && xs[j * 2] > kx) { xs[(j + 1) * 2] = xs[j * 2]; xs[(j + 1) * 2 + 1] = xs[j * 2 + 1]; j--; } xs[(j + 1) * 2] = kx; xs[(j + 1) * 2 + 1] = kd; }
			int wind = 0;
			for (int i = 0; i < nx - 1; i++) {
				wind += xs[i * 2 + 1]; if (wind == 0) { continue; }
				int64_t xa = xs[i * 2] < 0 ? 0 : xs[i * 2], xb = xs[(i + 1) * 2] > wmax ? wmax : xs[(i + 1) * 2]; if (xb <= xa) { continue; }
				int ia = (int)(xa >> 16), ib = (int)(xb >> 16);
				if (ia == ib) { acc[ia] += (uint32_t)((xb - xa) >> 8); } else { acc[ia] += (uint32_t)((65536 - (xa & 0xFFFF)) >> 8); for (int xi = ia + 1; xi < ib; xi++) { acc[xi] += 256; } if (ib < w) { acc[ib] += (uint32_t)((xb & 0xFFFF) >> 8); } }
			}
		}
		for (int x = 0; x < w; x++) { uint32_t v = (acc[x] * 255 + 512) >> 10; cov[(size_t)y * w + x] = (uint8_t)(v > 255 ? 255 : v); }
	}
	free(xs); free(acc); free(E.e); g->left = left; g->top = top; g->w = w; g->h = h; g->cov = cov; return g;
}
static void glyph_run_i(Ctx *c, int fontId, double size, double ls, double wsp, double x, double by, const double *col, double alphaMul, int n, const double *cps) {
	Font *f = &fonts[fontId]; Surf *S = cur(c); const double *cl = c->clips[c->nclips - 1].c; double prev = 0;
	int cx0 = (int)ceil(cl[0]), cy0 = (int)ceil(cl[1]), cx1 = (int)ceil(cl[2]), cy1 = (int)ceil(cl[3]);   /* integer pixel p is inside iff cx0 <= p < cx1 */
	int a8 = qa(col[3] * alphaMul), r = q8(col[0]), g8 = q8(col[1]), b = q8(col[2]); int iby = (int)by;
	for (int i = 0; i < n; i++) {
		uint32_t cp = (uint32_t)cps[i]; Slot *os = map_find(&f->outlines, cp, 0); double adv = (os ? ((Outline *)os->v.p)->adv : 0) * size;
		if (ls == 0 && prev) { Slot *ks = map_find(&f->kerns, ((uint64_t)(uint32_t)prev << 32) | cp, 0); if (ks) { x += ks->v.d * size; } }
		prev = cp;
		if (cp != 32 && cp != 160 && cp != 9) {
			int fxq = (int)js_round((x - floor(x)) * 4); Glyph *gl = get_glyph_i(f, cp, size, fxq, &c->misses); c->glyphs++;
			if (!gl->empty && a8 > 0) {
				int gx = (int)floor(x) + gl->left, gy = iby + gl->top;
				for (int yy = 0; yy < gl->h; yy++) { int py = gy + yy; if (py < cy0 || py >= cy1) { continue; } uint8_t *row = S->px + (size_t)py * S->w * 4; const uint8_t *cv = gl->cov + (size_t)yy * gl->w;
					for (int xx = 0; xx < gl->w; xx++) { int pxx = gx + xx; if (pxx < cx0 || pxx >= cx1) { continue; } int v = cv[xx]; if (v) { v = GAMMA[v]; blend_i(row + (size_t)pxx * 4, r, g8, b, a8 == 255 ? v : div255(a8 * v)); } } }
			}
		}
		x += adv + ls + (cp == 32 ? wsp : 0);
	}
}
static void pop_layer_i(Ctx *c, double alpha) {
	if (!c->nlayers) { return; } Surf sub = c->layers[--c->nlayers]; Surf *d = cur(c); int aq = qa(alpha);
	for (int yy = sub.by0; yy < sub.by1; yy++) { const uint8_t *sp = sub.px + ((size_t)yy * sub.w + sub.bx0) * 4; uint8_t *dp = d->px + ((size_t)yy * d->w + sub.bx0) * 4;
		for (int xx = sub.bx0; xx < sub.bx1; xx++, sp += 4, dp += 4) { int sa = sp[3]; if (sa) { blend_i(dp, sp[0], sp[1], sp[2], div255(sa * aq)); } } }
	free(sub.base);
}
