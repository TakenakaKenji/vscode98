/* svg98.h - the scanline loops of the SVG rasterizer (06-rendering/host/dom/svg.js fillPolys) in C, included by render.c. The JS loops were 0.9 s of the
 * laptop's v23 launch (the 559-byte code-icon.svg alone takes ~220 ms at 256x256 in QuickJS). Same arithmetic as the JS, step by step: doubles, the
 * coverage accumulator and the image stored as float32, the crossings of a sub-scanline sorted stably by x, so the result is the same to the bit
 * (06-rendering/tests/svg_native_oracle.mjs). Installed as the global __svgFill (svg.js falls back to its own loops without it). */

/* __svgFill(edges Float64Array [x0, y0, x1, y1, dir] * n (y0 < y1), ymin, ymax, W, H, evenOdd, r, g, b, a, out Float32Array W*H*4) */
static JSValue js_svg_fill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t eoff, elen, ebpe, esz, ooff, olen, obpe, osz;
	JSValue eab = JS_GetTypedArrayBuffer(ctx, argv[0], &eoff, &elen, &ebpe); if (JS_IsException(eab)) { return JS_EXCEPTION; }
	uint8_t *ep = JS_GetArrayBuffer(ctx, &esz, eab); JS_FreeValue(ctx, eab); if (!ep || ebpe != 8) { return JS_ThrowTypeError(ctx, "__svgFill: edges must be a Float64Array"); }
	JSValue oab = JS_GetTypedArrayBuffer(ctx, argv[10], &ooff, &olen, &obpe); if (JS_IsException(oab)) { return JS_EXCEPTION; }
	uint8_t *op = JS_GetArrayBuffer(ctx, &osz, oab); JS_FreeValue(ctx, oab); if (!op || obpe != 4) { return JS_ThrowTypeError(ctx, "__svgFill: out must be a Float32Array"); }
	const double *E = (const double *)(ep + eoff); int n = (int)(elen / 8 / 5); float *out = (float *)(op + ooff);
	double ymin, ymax, col[4]; int32_t W, H, evenOdd;
	if (JS_ToFloat64(ctx, &ymin, argv[1]) || JS_ToFloat64(ctx, &ymax, argv[2]) || JS_ToInt32(ctx, &W, argv[3]) || JS_ToInt32(ctx, &H, argv[4])) { return JS_EXCEPTION; }
	evenOdd = JS_ToBool(ctx, argv[5]);
	for (int k = 0; k < 4; k++) { if (JS_ToFloat64(ctx, &col[k], argv[6 + k])) { return JS_EXCEPTION; } }
	if (n == 0 || W <= 0 || H <= 0 || (size_t)W * (size_t)H * 4 > olen / 4 || isnan(ymin) || isnan(ymax)) { return JS_UNDEFINED; }
	const int SS = 4;
	double fy0 = floor(ymin), fy1 = ceil(ymax); int y0 = fy0 > 0 ? (fy0 < (double)H ? (int)fy0 : H) : 0, y1 = fy1 < (double)H ? (fy1 > 0 ? (int)fy1 : 0) : H;
	float *acc = calloc((size_t)W + 2, sizeof(float)); double *xs = malloc(sizeof(double) * (size_t)n); int *ds = malloc(sizeof(int) * (size_t)n);
	if (!acc || !xs || !ds) { free(acc); free(xs); free(ds); return JS_ThrowOutOfMemory(ctx); }
	for (int y = y0; y < y1; y++) {
		memset(acc, 0, sizeof(float) * ((size_t)W + 2));
		for (int s = 0; s < SS; s++) {
			double sy = y + (s + 0.5) / SS; int m = 0;
			for (int i = 0; i < n; i++) {
				const double *e = E + i * 5;
				if (sy >= e[1] && sy < e[3]) {
					double x = e[0] + (sy - e[1]) * (e[2] - e[0]) / (e[3] - e[1]); int d = (int)e[4];
					int j = m; while (j > 0 && xs[j - 1] > x) { xs[j] = xs[j - 1]; ds[j] = ds[j - 1]; j--; }   /* insertion: stable, like Array.prototype.sort */
					xs[j] = x; ds[j] = d; m++;
				}
			}
			int wind = 0;
			for (int k = 0; k < m - 1; k++) {
				wind += ds[k]; int inside = evenOdd ? ((k + 1) & 1) == 1 : wind != 0; if (!inside) { continue; }
				double xa = xs[k] > 0 ? xs[k] : 0, xb = xs[k + 1] < (double)W ? xs[k + 1] : (double)W; if (!(xb > xa)) { continue; }
				int ia = (int)floor(xa), ib = (int)floor(xb);
				if (ia == ib) { acc[ia] = (float)((double)acc[ia] + (xb - xa) / SS); }
				else { acc[ia] = (float)((double)acc[ia] + (ia + 1 - xa) / SS); for (int x = ia + 1; x < ib; x++) { acc[x] = (float)((double)acc[x] + 1.0 / SS); } if (ib < W) { acc[ib] = (float)((double)acc[ib] + (xb - ib) / SS); } }
			}
		}
		for (int x = 0; x < W; x++) {
			double v = acc[x]; double cov = isnan(v) ? v : (v < 1 ? v : 1); if (!(cov > 0)) { continue; }
			double a = cov * col[3]; size_t o = ((size_t)y * (size_t)W + (size_t)x) * 4; double da = (double)out[o + 3] / 255; double oa = a + da * (1 - a); if (!(oa > 0)) { continue; }
			out[o] = (float)((col[0] * a + (double)out[o] * da * (1 - a)) / oa); out[o + 1] = (float)((col[1] * a + (double)out[o + 1] * da * (1 - a)) / oa); out[o + 2] = (float)((col[2] * a + (double)out[o + 2] * da * (1 - a)) / oa); out[o + 3] = (float)(oa * 255);
		}
	}
	free(acc); free(xs); free(ds); return JS_UNDEFINED;
}
/* __svgToRGBA8(Float32Array) -> Uint8Array: clamp(round(v)) of each value (Math.round: floor(v + 0.5), exact for a float32 in double) */
static JSValue js_svg_rgba8(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t off, len, bpe, sz; JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &off, &len, &bpe); if (JS_IsException(ab)) { return JS_EXCEPTION; }
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, ab); JS_FreeValue(ctx, ab); if (!p || bpe != 4) { return JS_ThrowTypeError(ctx, "__svgToRGBA8: a Float32Array"); }
	const float *f = (const float *)(p + off); size_t n = len / 4; uint8_t *o = malloc(n ? n : 1); if (!o) { return JS_ThrowOutOfMemory(ctx); }
	for (size_t i = 0; i < n; i++) { double r = floor((double)f[i] + 0.5); o[i] = r >= 255 ? 255 : r > 0 ? (uint8_t)r : 0; }   /* NaN -> 0, as a Uint8Array stores NaN */
	JSValue r = JS_NewUint8ArrayCopy(ctx, o, n); free(o); return r;
}
static void js98_svg_install(JSContext *ctx) {
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__svgFill", JS_NewCFunction(ctx, js_svg_fill, "__svgFill", 11));
	JS_SetPropertyStr(ctx, g, "__svgToRGBA8", JS_NewCFunction(ctx, js_svg_rgba8, "__svgToRGBA8", 1));
	JS_FreeValue(ctx, g);
}
