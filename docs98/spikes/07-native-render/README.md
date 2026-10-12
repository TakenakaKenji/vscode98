# Spike 7 — native layout and rasterizer on QuickJS-ng

**Question** (D-005, [spike 6](../06-rendering/README.md)): spike 6 showed that a pure-JavaScript DOM + CSS + layout + painter reproduces Monaco and most of the workbench, but slowly on QuickJS-ng. Can the layout and the rasterizer move to C, with identical results, and how much of the frame time does that remove? Where does the remaining time go?

- **Engine/host:** QuickJS-ng 0.17.0 with the spike 5 host plus two C modules from this spike (`spike:render`, `spike:layout`). **Machine:** Intel Xeon @ 2.1 GHz, 4 vCPU, Linux, gcc 13 `-O2`. x86-64, and an x86-32 build on the 64-bit kernel.
- **Everything ran on Linux.** The C is portable ANSI C99 + libm (no platform calls), but nothing was built or run on Windows.
- **Inputs are the same as spike 6:** the 4 live Monaco scenarios and the captured workbench (1280×800, 1,015 elements). The JS engine of spike 6 is the oracle: native output is compared with it byte for byte.

## Verdict

1. **The rasterizer and the layout engine both move to C with exactly the same results.** On all 5 test pages (4 Monaco scenarios, workbench replay) the native layout gives **identical geometry** (every element's rectangle, offset/scroll size, 0 elements differ) and the native (exact) rasterizer gives **byte-identical framebuffers** to the JavaScript implementation (the integer rasterizer added later is within 2 colour levels, see the CPU baseline section), on x86-64 and on x86-32 (the host and the C compiled with gcc's default x87 floating point, and again with `-msse2 -mfpmath=sse`). Since spike 6 matches Chromium to 0.5 px on Monaco, the native code inherits that.
2. **The speed-up is large where C runs, and it moves the bottleneck.** Workbench replay on QuickJS-ng, JS vs native: layout **0.36 to 0.48 s → 0.022 to 0.031 s** (warm, ~15×); paint **3.1 s → 0.05 s** (warm, ~60×; 0.09 s cold); live Monaco paint 390 to 530 ms → 13 to 17 ms. Layout and paint stop being a problem.
3. **The bottleneck is now CSS style resolution, specifically selector matching.** The same pass spends **1.7 to 1.9 s (warm) / ~4 s (cold)** in style, now 98 % of the frame. I had this wrong in spike 6 (it lumped style with layout and concluded layout and rasterization "have to become native"); in fact layout was only 0.8 s of 7.3 s. A profile of the style pass: **90 % of it (3.7 of 4.1 s) is matching 16,758 rules against 3,048 elements/pseudo-elements: 1.34 million candidate tests for 3,783 matches**; value parsing, cascade merge and `var()` substitution together are ~0.3 s. An ancestor Bloom filter added to the JS (identical output) cuts matching 3.7 s → 1.15 s and style 4.1 s → 1.6 s. That is still ~1.6 s per full restyle, so the next engine work is selector matching (native, and/or incremental invalidation so only changed elements are restyled), not layout or paint.
4. **Marshalling is cheap.** Packing the styled box tree for C costs 10 to 17 ms for ~790 boxes (warm), the C layout 4 to 6 ms (Monaco pages: 0.3 to 0.6 ms), copying results back 1.5 to 2.5 ms. The first pack of a run costs ~0.5 s: that is font loading and glyph lookup in opentype.js (I did not split the two), which the JS layout paid as well.
5. **Not done:** painting traversal in C (the display list is still produced by JavaScript, 8 to 18 ms), a native font parser (fonts are still parsed by opentype.js; C gets advances, kerning pairs and outlines handed over once per glyph), a GDI/Windows backend for the display list, incremental layout, anything on Windows. Memory is unchanged (218 MB RSS both, dominated by the DOM/style data).

## Results

Workbench replay, QuickJS-ng, x86-64. "warm" = a second, third, ... pass in the same process (fonts loaded, glyph cache filled). Variation between runs is ±15 %.

| Step | JS cold | JS warm | Native cold | Native warm |
|---|---|---|---|---|
| Style (selector matching + cascade; unchanged in both, includes the Bloom filter) | 4.0 s | 1.7 to 1.9 s | same | same |
| Layout | 0.81 s | 0.36 to 0.48 s | 0.55 s (0.53 s of it is the first pack: one-time font loading in JS) | **0.022 to 0.031 s** (pack 10 to 17 + C 4.4 to 5.1 + copy back 1.4 to 2.5 ms) |
| Paint (traversal + rasterization, without PPM conversion) | 3.1 to 3.3 s | 3.1 to 3.2 s | 0.06 to 0.09 s | **0.048 to 0.056 s** (record 8 ms + C execute 40 to 47 ms) |

Node v22.22.0 (V8 JIT), same steps cold: style 0.71 s, layout 0.23 s, paint 0.28 s. Warm native layout on QuickJS (22 to 31 ms) is about 8× faster than V8's cold JS layout, which is not a like-for-like comparison (JIT warm-up and font loading are in the V8 number).

Live Monaco on QuickJS-ng (800×520, layout + paint through the native engine, compared with the JS engine):

| Scenario | Elements | Geometry vs JS | Framebuffer vs JS | JS paint | Native paint |
|---|---|---|---|---|---|
| `basic` | 92 | identical | byte-identical | 529 ms | 17 ms |
| `dark_tokens` | 341 | identical | byte-identical | 394 ms | 17 ms |
| `features` | 300 | identical | byte-identical | 458 ms | 13 ms |
| `proportional_wrap` | 195 | identical | byte-identical | 391 ms | 15 ms |
| workbench replay | 1,016 | identical | byte-identical | 3,138 ms | 61 ms |

Native paint in the warm workbench repaint is dominated by C execution (40 to 47 ms for a full 1280×800 frame, unoptimized scalar C with per-pixel `double` blending for translucent fills); there is plenty of room (integer blending, SIMD, dirty rectangles), but the exact `double` arithmetic is what makes the comparison byte-exact, so it was kept.

## What was built (`host/`)

| File | Size | What |
|---|---|---|
| `render.c`, `raster_int.h` | 270 + 215 lines | module `spike:render`: display-list rasterizer. Commands (fill rect, rounded rect, clip push/pop, opacity layers, glyph runs) are a Float64 stream recorded by JS. Glyph coverage with the same non-zero-winding scanline sampler as spike 6, cached per font/size/quarter-pixel offset; the font tables (advances, kerning pairs, vertical metrics, outlines) are filled by JS and also read by `layout.c`. `-ffp-contract=off`, same operation order and rounding (round-half-even into `Uint8ClampedArray` semantics) as the JS. |
| `layout.c` | 620 lines | module `spike:layout`: a port of the layout half of `06-rendering/host/dom/layout.js`: block flow with margin collapsing, inline formatting (line breaking, `white-space`, tabs, `break-all`/`overflow-wrap`, inline boxes with per-line rectangles, baseline alignment), inline-block, replaced elements (sizes supplied by JS), flexbox including wrap/grow/shrink/align/justify/auto margins/anonymous text items, absolute/fixed/relative positioning, scroll extents. `null` is `NaN`. One arena per run. |
| `layout_pack.js` | | packs the styled box tree (the JS `Layout.build` result) into a `Float64Array` of 80-field records, a calc() node pool and a UTF-16 text pool; hands advances/kerning for the text to C |
| `native_layout.js` | | `env.layoutEngine` plug-in: pack, call C, copy geometry, text fragments, inline rectangles and anonymous flex boxes back onto the `Box` objects so painting, `getBoundingClientRect()` etc. work unchanged |
| `native_backend.js`, `native_fonts.js` | | display-list recorder (`paintDocument(doc, w, h, backend)`), font registration and on-demand data hand-over |
| `build.sh`, `build_baseline.sh`, `check_isa.sh` | | builds `qjs-spike7` (spike 5 host + both modules); `M32=1` for 32-bit, `CFLAGS_EXTRA` for extra flags; `build_baseline.sh` = the i586/x87 baseline binary plus the instruction-set check |
| `tests/native_compare.sh`, `tests/pixel_tolerance.py` | | native vs JS reference: geometry identical, exact rasterizer byte-identical, integer rasterizer within tolerance |

Changes to spike 6 (all output-neutral, checked by identical framebuffers against the previous code): `paint.js` split into a traversal and a pluggable backend (`JsBackend` is the old code); `layout.js` got the `env.layoutEngine` hook, exported `Box`/`anonStyle`, split timing (`styleMs`, `layoutMs`); the ancestor Bloom filter in `css.js`/`layout.js`; the runners got `--layout native`, `--backend native`, `--repeat`, `--repaint` and now time paint without the PPM conversion (which used to be inside "painted in", ~0.1 to 0.3 s on QuickJS; spike 6's paint figures were inflated by that).

## What I learned while porting (worth knowing for a real engine)

- **Marshalling is not the problem, state is.** Because style and box-tree building stay in JS and the whole tree is re-packed every pass, the boundary cost is ~15 ms per 790 boxes; a persistent native tree with incremental updates would remove even that, but there is no reason to start there.
- **The font boundary is data, not calls:** giving C each advance, kerning pair and outline the first time JS sees it (no callbacks from C into JS) was enough and kept the C code free of font parsing. A native font reader (TrueType/CFF/OpenType kerning) is the missing piece for a standalone build.
- **Exactness is achievable but needs discipline:** same operation order, `-ffp-contract=off`, `Math.round` = `floor(x + .5)`, stable sort, `Float32Array` accumulators emulated with a `float` store, `Uint8ClampedArray` half-even rounding. On 32-bit x86 (x87 or SSE2) the results were also identical.
- **Quirks of the JS layout found by reading it while porting (kept as is so the two stay identical; not verified on a page and not fixed):** inline boxes that wrap over several lines get width 0 for all but the last line rectangle; `finishLine` runs twice on the last line when a trailing empty line is dropped (double alignment shift); inline-blocks nested in an inline span are never absolutized; the anonymous flex text box copies its parent's `background-color` (it would be painted twice). One real bug was fixed in both: `shiftFrags` did not shift the text baseline (no test page exercised it).
- **32-bit builds are slower in C too** (cold full-frame execute 130 to 190 ms instead of 45 to 60 ms), mostly the `double` blend math without SSE2; on a Pentium II/III (no SSE2) this would need an integer blend path.

## CPU baseline: Pentium-class x87, no SSE2, and the integer rasterizer (decision D-009)

Nothing in the C needs SSE2; it is a compiler flag. The shipping baseline is **one 32-bit x86 binary for a Pentium-class x87 CPU: no SSE, no SSE2, no MMX, no CMOV** (so it also runs on a Pentium MMX or K6, not just on Pentium III/Athlon and later). `host/build_baseline.sh` rebuilds QuickJS-ng, the shims and both modules with `-m32 -march=i586 -mno-sse -mno-sse2 -mno-mmx -mfpmath=387` and `host/check_isa.sh` verifies the result with `objdump` (0 xmm, 0 mm, 0 cmov, 0 SSE mnemonics; it fails on the x86-64 build and on a plain `-m32` build, which has 948 CMOV). `render.c` sets the x87 precision control to 53 bits at start-up (`_FPU_SETCW` / `_controlfp`), so doubles behave as ECMAScript requires and as SSE2 does. The check covers our binary, not the C library it links against (on Windows that is the platform CRT, not examined here).

**The exact (double) rasterizer was the only part that suffered** (~300 ms per frame on x87, 6× the x86-64 time). It is now complemented by an **integer rasterizer** (`raster_int.h`): 8-bit colour and alpha, coverage in 0..256, 24.8 geometry, glyph outlines flattened and scan-converted in 16.16 with 64-bit integer intermediates, rounded-corner distance with an integer square root, opacity layers that only allocate the clipped region. Floating point is used once per operation and once per glyph (advance and sub-pixel position, so glyphs land exactly where the exact rasterizer puts them). The exact rasterizer stays as the reference (`--backend native-exact`, byte-identical to the JS painter); `--backend native` is the integer one.

Accuracy of the integer rasterizer against the JS reference (all 5 pages, also on the baseline binary): largest difference of any colour channel **1 to 2 levels out of 255**, mean absolute difference 0.004 to 0.047, at most 0.011 % of values off by more than 1. Geometry stays identical.

Workbench replay on QuickJS-ng, warm, full 1280×800 frame (native layout + native paint):

| Build | Layout (pack + C + copy) | Paint, C only | Paint, record (JS) |
|---|---|---|---|
| x86-64, exact rasterizer | 20 to 40 ms | 40 to 60 ms | 8 to 12 ms |
| x86-64, **integer rasterizer** | 25 to 29 ms | **2.8 to 3.7 ms** | 9 to 14 ms |
| **baseline (i586 x87), integer rasterizer** | 40 to 44 ms | **4.1 to 4.2 ms** | 16 ms |
| (earlier) x86-32 i586 x87, exact rasterizer | 28 to 43 ms | 300 to 315 ms | |

On the baseline the rasterizer is now ~70× faster than the exact one was, and it is no longer the dominant paint cost: the JS display-list traversal (record) is. Profile of the old exact path: rounded rectangles were 29 to 34 of 40 ms (per-pixel `hypot`), full-size opacity layers 17 to 28 ms; both are gone in the integer path (rounded rects 1 ms, layers 0.2 ms, clipped to the region that can change).

Not tested: any real or emulated Pentium/K6/Athlon CPU (all runs are on a modern Xeon executing the same instructions), 32-bit Windows, a Windows C runtime.

## Reproduce

Needs QuickJS-ng built with cmake in `$QJS/build` (and `build32` for the 32-bit build), the spike 6 prerequisites (Node, Playwright Chromium for the Chromium comparison only, Inter/DejaVu/Liberation fonts), the Monaco bundle (`node docs98/spikes/06-rendering/host/build_monaco.mjs <dir>`) and a captured workbench (`capture_workbench.sh`, see spike 6). From the repo root:

```bash
bash docs98/spikes/07-native-render/host/build.sh /tmp/s7                 # -> /tmp/s7/qjs-spike7  (M32=1 for 32-bit)
QJS7=/tmp/s7/qjs-spike7 bash docs98/spikes/07-native-render/tests/native_compare.sh <monacoDir> <workbench.json> /tmp/n7
bash docs98/spikes/07-native-render/host/build_baseline.sh /tmp/base586        # i586/x87 baseline + ISA check; run native_compare.sh with QJS7=/tmp/base586/qjs-spike7
# timings, warm passes:
( ulimit -s 1048576; /tmp/s7/qjs-spike7 --stack-size 0 docs98/spikes/06-rendering/host/run_replay_qjs.mjs <workbench.json> --layout native --backend native --ppm out.ppm --repeat 3 --repaint 3 )   # --backend native = integer rasterizer, native-exact = double reference, js = JS; --profile 1 prints per-operation C times
```

## What this means for D-005

- **Evidence for** "own DOM + layout + software renderer, with layout and rasterization in C": identical results to the JS reference, ~15× (layout) to ~60× (paint) faster on the target engine, small marshalling cost, portable C that also runs as x86-32.
- **The next costs to attack:** (1) selector matching/style resolution (1.7 to 1.9 s warm for the workbench; native matcher and/or incremental restyle), (2) moving the paint traversal and the whole box tree into C, (3) a native font reader, (4) a real backend for the display list (GDI on Windows, using the same command stream) and the Canvas 2D calls, (5) Windows builds of everything. None of these was tested here.
- **Still open:** the workbench running live on this DOM (events, focus, IME), SVG/shadows/rotation (spike 6 gaps), memory on a 64 to 256 MB machine.
