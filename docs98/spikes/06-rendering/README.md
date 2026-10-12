# Spike 6 — a small DOM + CSS layout + software renderer: Monaco, and a replay of the real workbench

**Question** (D-005, [CHECKPOINT](../../CHECKPOINT.md)): can a small, self-written DOM + CSS engine + layout + software painter, running on QuickJS-ng, run Monaco and draw it, and how much of the real VS Code workbench layout does it reproduce? No Chromium, no GDI yet: the painter writes into a framebuffer in JavaScript, so this measures the *engine* (DOM, style, layout, paint), not the Windows backend.

- **Engine:** QuickJS-ng 0.17.0 with the spike 5 host (`qjs-spike5`), and Node 24.18.0 as a faster reference for the same JS. **Machine:** Intel Xeon @ 2.1 GHz, 4 vCPU, Linux.
- **Ground truth:** Playwright headless Chromium (`chromium_headless_shell-1194`), same fonts (Inter, DejaVu Sans Mono, Liberation) and the same page. Every element's box, offset/client/scroll size, inline style and `outerHTML`, plus a screenshot.
- **Everything ran on Linux, in JavaScript.** Nothing was drawn through GDI/Windows APIs, nothing ran on Windows.
- **Two different tests, do not mix them up:**
  1. **Live Monaco (4 scenarios):** the real, unmodified Monaco editor (built from `src/vs/editor/editor.main.ts`) *executes* on our DOM, builds its own DOM, reads geometry back from our layout and we paint the result.
  2. **Static workbench replay:** the real workbench ran once in Chromium (headless, production bundle); its final DOM, all CSS and scroll offsets were captured, and our engine styles, lays out and paints that *snapshot*. The workbench's JavaScript did **not** run on our DOM, so this shows layout/paint coverage, not that the workbench boots.

## Verdict

1. **Monaco runs, and the geometry is exact.** In 4 scenarios (about 80 to 340 elements each) the same elements exist as in Chromium, class and inline-style attributes are identical, and **every box that is not an SVG element is within 0.5 px** of Chromium (`x, y, w, h`). Pixel error is small (mean absolute error 0.1 to 1.4 out of 255). The framebuffer produced on QuickJS-ng is **byte-identical** to the one on Node.
2. **The real workbench's layout is about 75 % reproduced at 1 px, with known causes for most of the rest.** 422 of 566 non-empty boxes are within 1 px of Chromium (435 within 2 px), 924 of 975 `offsetWidth` and 948 of 975 `offsetHeight` match, the text of 966 of 975 elements matches. Painted result: activity bar, explorer tree with codicons and Seti file icons, panes, chat view, status bar, toast, keybinding hints are all there at the right places (see the screenshots). Mean pixel error 2.4/255; 3.3 % of pixels differ by more than 16.
3. **A DOM + CSS + layout engine of about 210 KB of JavaScript (a few thousand characters per line, see the table) is enough for this.** Monaco and the workbench need only block/inline/inline-block/absolute/fixed/relative/flex, overflow clipping and scrolling, `var()`, `calc()`, nesting, `@media`/`@supports`/`@layer`, `@font-face`: no grid, no float, no table layout appeared in either (the engine reports each unsupported feature it meets; all of these reports were empty for Monaco).
4. **Speed on QuickJS is the weak point.** One static workbench pass: style + layout **1.3 s on Node, 7.3 s on QuickJS-ng (5.7×)**; paint **0.3 s vs 3.3 s (11×)**; 218 MB RSS on QuickJS (272 MB on Node). That is one cold pass over ~1,000 elements at 1280×800, with no incremental invalidation. An interactive workbench needs single-digit milliseconds per frame. **Correction (measured afterwards in [spike 7](../07-native-render/README.md)):** the 7.3 s is 6.1 s style (selector matching, 90 % of it) and only 0.8 s layout, so this item was wrong to say layout and the rasterizer were the problem; the paint time quoted here (3.3 s) also included the PPM file conversion (about 0.1 s for Monaco, 0.3 s for the workbench), real paint is ~3.1 s. Spike 7 moved layout and rasterization to C with identical results (layout 15× and paint 60× faster); the style pass is what remains.
5. **Not shown:** the real workbench *running* on this DOM (event model, focus, IME, drag and drop, live relayout, input latency), animated or incremental rendering, text shaping beyond simple Latin (no complex scripts, no bidi, no emoji), real text rasterization quality (grayscale non-hinted coverage; no ClearType/GDI text), SVG, shadows, rotation, and anything on Windows.

## What was built (`host/dom/`, sizes in bytes; lines are very long)

| File | Bytes | What |
|---|---|---|
| `dom.js` | 43,056 | Node/Element/Text/Document, events (capture/bubble, `composedPath`), `classList`, style declaration `Proxy`, `innerHTML` parser, `Range`/`Selection`, `MutationObserver`, `customElements` |
| `selectors.js` | 11,325 | selector parser and matcher (combinators, attribute selectors, `:not/:is/:where/:has` subset, structural pseudo-classes, pseudo-elements) |
| `css.js` | 44,971 | CSS parser (nesting, string/escape-safe scanners, `@media/@supports/@layer` flattening, `@font-face`), lengths and `calc()`, colors incl. `color-mix`, shorthand expansion, cascade with specificity/order/`!important`, `var()`, inheritance, computed style (copy-on-write custom properties), parse cache |
| `layout.js` | 47,051 | block flow with margin collapsing, inline formatting (line breaking, `white-space` modes, floored half-leading like Chromium), inline-block, flexbox (wrap, grow/shrink, align/justify, reverse), absolute/fixed/relative, min/max/percent sizing, overflow/scroll geometry, translate/scale transforms, `::before/::after` boxes |
| `paint.js` | 17,553 | software painter: backgrounds with radius, solid borders, text via a non-zero-winding scanline rasterizer with a glyph cache, clipping, scroll offsets, group opacity, PPM output |
| `fonts.js` | 7,054 | family to file matching, `@font-face` registration (`data:`, `file:`, `vscode-file:`), advances and vertical metrics, pair kerning (via opentype.js) |
| `env.js` | 31,031 | window globals (rAF, observers, storage, canvas 2D stub, `navigator`, ...), the geometry API (`getBoundingClientRect`, `offset*`, `client*`, `scroll*`, `elementsFromPoint`, `Range.getClientRects`) on top of layout, lazy relayout when dirty |
| `intl_shim.js`, `replay_core.js`, `page_loader.js` | 4,597 / 2,727 / 1,245 | `Intl` stand-ins (QuickJS has none), workbench snapshot rebuild, page loader |

Fonts come from `opentype.js` (already in the repo's `node_modules`). Drivers and tools: `host/run_node.mjs`, `host/run_qjs.mjs` (live Monaco), `host/run_replay_node.mjs`, `host/run_replay_qjs.mjs`, `host/build_monaco.mjs`, `host/capture_workbench.{sh,mjs}`, `tests/*` (ground truth, comparisons, scenarios).

## Results

### Live Monaco (800×520, 4 scenarios)

| Scenario | What it exercises | Elements | Boxes within 1 px | Mean abs pixel error | Pixels off by more than 16 |
|---|---|---|---|---|---|
| `basic` | plain text, line numbers, cursor, current-line highlight | 79 | 79 / 79 | 0.11 | 0.19 % |
| `dark_tokens` | Monarch tokenizer, dark theme, folding chevrons | 341 | 313 / 326 | 0.39 | 0.63 % |
| `features` | decorations (inline, line, glyph), wavy underline, selection, find-like ranges | 288 | 288 / 288 | 1.37 | 2.46 % |
| `proportional_wrap` | proportional font (Inter), word wrap, mixed widths | 195 | 184 / 184 | 1.26 | 2.37 % |

- In `dark_tokens` all 13 boxes that are not within 1 px are SVG `<path>` elements (the folding chevrons): SVG is not implemented, so they have size 0.
- `proportional_wrap` needed floored half-leading and Inter weight selection; before the fix its mean pixel error was 13.3. Kerning is not applied to Inter (opentype.js does not read its class-based kerning), which is the remaining difference there.
- In `features` the wavy underline is drawn straight and text anti-aliasing differs from Chromium's; I did not break the pixel error down further.
- **QuickJS-ng:** the same 4 scenarios produce element dumps equal to Node's and **framebuffers byte-identical to Node's**. Monaco load + first layout: 1.1 s on Node, 1.9 s on QuickJS for `proportional_wrap`; paint 0.12 s vs 0.62 s.
- Getting Monaco to run on QuickJS exposed `TextDecoder('utf-16le')` missing (Monaco rendered nothing until added), no `Intl`, no `console.error`.

### Static replay of the real workbench (1280×800, 1,015 elements, 24 style sheets)

| Metric | Value |
|---|---|
| Boxes within 0.5 / 1 / 2 px | 133 / 422 / 435 of 566 non-empty |
| `offsetWidth` / `offsetHeight` match | 924 / 975 and 948 / 975 |
| `scrollWidth/Height` match | 858 / 975 |
| Text content match | 966 / 975 |
| Class / inline-style attribute mismatches | 0 / 0 |
| Pixels | mean abs error 2.36/255; > 16: 3.3 %; > 64: 1.5 %; > 128: 0.4 % |
| Node | build 19 ms, style + layout 1.3 s, paint 0.3 s, 272 MB RSS |
| QuickJS-ng | build 57 ms, style + layout 7.3 s, paint 3.3 s, 218 MB RSS, framebuffer identical to Node's |

Screenshots (left Chromium, right ours): [`results/workbench-chromium.png`](results/workbench-chromium.png), [`results/workbench-ours.png`](results/workbench-ours.png); Monaco: `results/monaco-{basic,features}-{chromium,ours}.png`.

**What differs in the workbench replay (all identified, none fixed):**
- **Title bar** (it holds most of the large errors): the window-controls overlay uses `env(titlebar-area-*)` and `navigator.windowControlsOverlay`, which we do not model, so the center and right groups are placed differently.
- **Text:** Inter kerning is not applied (glyph run widths differ by fractions of a pixel, which breaks some `flex` intrinsic sizes and wrapping, e.g. "Show All Commands" stays on one line in ours, wraps in Chromium).
- **Not painted yet** (the painter reports each one): SVG (the large watermark logo, graph glyphs), `box-shadow` (20), rounded borders (15, drawn square), `outline` (2), `background-image` (2), masks, canvas contents (the editor's minimap and decorations are Canvas 2D).
- **Transforms on pseudo-elements and rotation:** the tree twisties are drawn as "expanded" chevrons because the collapsed state is a `rotate(-90deg)` on `::before`, and only translate/scale are painted.
- **Flex nuances:** some percent-basis and intrinsic-size cases are 1 to 3 px off (not analysed one by one).

## What had to be handled (design notes for a real engine)

- **Layout fidelity depends on small Chromium rules**, not on the big features: floored half-leading, auto-margin distribution after the width is known, blockification of flex items (including pseudo-elements), percent heights only when the containing block height is definite, kerning off when `letter-spacing` is set, `max-width` keywords, scrollable overflow rects.
- **Style cost dominates on QuickJS.** The first version took 29.6 s for the workbench; caching parsed values, copy-on-write custom properties, a per-element class cache, rule indexing by rightmost compound and skipping pseudo-style when nothing matches brought it to 7.3 s (Node: 3.2 s to 1.3 s).
- **Fonts:** CFF outlines (Inter `.otf`) lack closing `Z` commands and overlap, so the rasterizer needs contour closing and non-zero winding; kerning needs real GPOS class support; `font-family` fallbacks and weights (Inter has 9 files) need a real matcher.
- **QuickJS gaps found:** `Intl` (a 21-line stand-in covers what Monaco/workbench call at startup, not locale correctness), `console.error`, `TextDecoder` encodings; none needed engine changes.
- **Monaco options used to keep both sides comparable:** `editContext: false` (the `EditContext` API does not exist in our DOM), fixed font and size, no minimap, `automaticLayout: false`, no smooth scrolling.

## Reproduce

Needs Node 24.18 on `PATH`, the repo's `node_modules`, Playwright Chromium, and the fonts `Inter` (`/usr/share/fonts/opentype/inter`), DejaVu and Liberation (the paths are listed in `host/dom/fonts.js`; `host/run_replay_*.mjs` also hard-code `/home/user/vscode98/node_modules/opentype.js`). From the repo root:

```bash
# 1. Monaco bundle (esbuild, IIFE + css)
node docs98/spikes/06-rendering/host/build_monaco.mjs /tmp/monaco
# 2. the 4 Monaco scenarios: Chromium ground truth, our engine on Node, comparisons (add QJS=<qjs-spike5> to also run QuickJS)
bash docs98/spikes/06-rendering/tests/run_scenarios.sh /tmp/monaco /tmp/sc
# 3. workbench snapshot (needs the staged production bundle, see docs98/inventory/baseline-bundle.md), then replay + compare
bash docs98/spikes/06-rendering/host/capture_workbench.sh /tmp/wbrun /tmp/workbench.json
bash docs98/spikes/06-rendering/tests/replay_compare.sh /tmp/workbench.json /tmp/wb
# 4. the replay on QuickJS (spike 5 host binary from docs98/spikes/05-child-process/host/build.sh)
( ulimit -s 1048576; qjs-spike5 --stack-size 0 docs98/spikes/06-rendering/host/run_replay_qjs.mjs /tmp/workbench.json --dump /tmp/q.json --ppm /tmp/q.ppm )
```

Captured data (`workbench.json`) is not committed; step 3 regenerates it.

## Changes to earlier spike files

For QuickJS-ng to run Monaco, spike 5/6 extended `../02-node-shim/host/globals.js` (`TextDecoder` utf-16le/latin1, a native UTF-8 hook that respects the encoding, a few `Buffer` additions, `Intl.ListFormat`), `impl/{events,util,fs,original-fs,fs__promises,module}.js`, `gen_shims.mjs`, and `../03-extension-loading/run_ext.mjs`. Spikes 2 and 3 were not re-run in full after these edits.

## What this means for D-005

- **Evidence for** a custom render layer: the CSS/DOM surface the product needs is small enough that a ~210 KB JS engine reproduces Monaco exactly and the workbench layout mostly; the remaining gaps are known features (SVG, shadows, kerning, env(), rotation), not unknown unknowns. Both ends of the pipeline (DOM/style/layout in JS, painter producing a framebuffer) already run on QuickJS with results identical to Node.
- **Evidence against doing it all in JS on QuickJS:** a cold pass of 7 s style + layout and 3 s paint is far from interactive. *(Updated by spike 7: layout and rasterization were moved to C with identical results and are no longer the problem; selector matching in the style pass is, see [spike 7](../07-native-render/README.md).)*
- **Not tested at all:** Windows (GDI/DirectDraw, text rendering, fonts on 98/XP, memory on a 64-256 MB machine), the Canvas 2D usage of the editor and minimap, webviews (need real table layout), and the workbench actually running on this DOM. Those, and a native layout/paint, are what the next rendering spike would have to cover.
