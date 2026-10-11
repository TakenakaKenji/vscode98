# Inventory — Runtime Trace of the Renderer (Startup)

Pass 3, first slice. Measured, not grepped: what the workbench window **actually calls** while starting.

- **Taken at:** `32bbe1b8` (1.142.0), Electron 43.7.7 / Chromium 150, Linux, headless (`--ozone-platform=headless`), dev mode (unbundled `out/`), default theme.
- **Scenario:** cold start, one folder open (4 small files), `lifecycle.ts` opened in the editor, then idle 40 s. Viewport emulated at 1440×900.
- **Tool:** [scripts/trace_renderer.mjs](scripts/trace_renderer.mjs) (CDP: wraps DOM/Web API prototypes with counters before load, reloads, then collects).
- **Raw data:** [data/renderer-trace-startup-1440x900.json](data/renderer-trace-startup-1440x900.json).

## Limits of this trace (read first)

- **Startup only.** No typing, scrolling, search, terminal, git, debugging, webviews, notebooks, or extensions beyond the built-ins. Those will add APIs; they need scripted scenarios (planned).
- **Dev mode.** Unbundled loading inflates some numbers (`new Blob` 488, `CSS.escape()` 8,035, 400 stylesheets / 376 `<link>`s), which a bundled build would not show. Do not use those as host requirements.
- **Renderer only.** Node/Electron calls in the main, shared, and extension-host processes are **not** traced yet.
- **Instrumented subset.** Only ~45 interfaces + ~35 constructors/functions are wrapped (listed in the script). An API not on the list is invisible, not unused.
- Counts of calls are for one run; use them for ranking, not as exact values.

## Headline findings

1. **Only 180 distinct DOM/Web members were called** at startup, across 27 interfaces. The static grep suggested a much larger surface; the real starting requirement is modest and enumerable (full list in the JSON).
2. **Only 227 distinct standard CSS properties** are declared across 13,758 rules (the other 3,454 distinct names are `--vscode-*` custom properties, i.e. theme variables). A CSS engine can target a known list of ~227 properties.
3. **Layout in use is simple:** of 1,846 live elements: `display: block` 813, `none` 549, `flex` 245, `inline` 227, `inline-block` 9, `inline-flex` 1, `contents` 2. **No element uses `display: grid`** at startup (though grid appears in CSS files). `float` is used by 4 elements. `position`: static 1,154, absolute 537, relative 155; **no fixed or sticky**. Flex direction is almost always `row` (1,824 vs 21 `column`).
4. **Visual effects are rare:** `border-radius` 185 elements, `z-index` 87, `opacity < 1` 52, `box-shadow` 46, `transform` 40, `transition` 19, `will-change` 2, `filter` 1, `mask/clip-path` 1. Gradients/backdrop-filter essentially absent here.
5. **The editor is DOM + `<textarea>`, not canvas or contentEditable.** 0 `contentEditable` elements, 4 `<input>/<textarea>`. `HTMLElement.editContext` was only *read* (1,417 times). Canvas 2D is limited to 11 canvases doing `fillRect`/`fillText`/`putImageData`/line drawing (minimap, overview ruler, similar). No WebGL.
6. **No iframes/webviews, no shadow DOM** at startup.
7. **Workers/WASM:** 2 `new Worker`, 1 `WebAssembly.instantiateStreaming` (syntax highlighting engine). Confirms that WASM must be provided for highlighting.
8. **Scheduling and events dominate calls:** `addEventListener` 16.8k, `removeEventListener` 14.4k, `setTimeout` 949, `requestIdleCallback` 412, `requestAnimationFrame` 145, `MessagePort.postMessage` ~2.7k. The host needs a fast event loop and idle-callback scheduling.
9. **Memory:** renderer JS heap ≈ 123 MB used at idle (dev mode, empty-ish workspace). A real number for the old-OS memory budget (see [../03-targets-and-limits.md](../03-targets-and-limits.md)); Win 98 budgets are tight.
10. **Page load:** DOMContentLoaded at ~0.8 s after reload (cached), but this excludes the async workbench start-up that follows.

## DOM/Web calls by interface (calls / distinct members)

| Interface | Calls | Members |
|---|---|---|
| Element | 41,327 | 46 |
| EventTarget | 28,169 | 2 |
| Node | 13,316 | 19 |
| DOMTokenList (`classList`) | 11,837 | 7 |
| HTMLElement | 10,893 | 16 |
| Document | 9,400 | 20 |
| CSS (`CSS.escape`) | 8,035 | 1 (dev-mode artifact) |
| CanvasRenderingContext2D | 4,514 | 16 |
| MessagePort | 2,746 | 3 |
| URL | 981 | 3 |
| Performance | ~860 | 5 |
| HTMLCanvasElement | 736 | 5 |
| CSSStyleDeclaration | 561 | 3 |
| Worker | 151 | 3 |
| HTMLStyleElement | 102 | 3 |
| MutationObserver | 76 | 3 |
| CSSStyleSheet | 50 | 3 |
| ResizeObserver | 9 | 1 |
| Storage, Navigator, Attr, NamedNodeMap, crypto, HTMLImageElement, HTMLInputElement, TextMetrics, WebAssembly | < 60 each | 1–5 each |

## Most-called members

`EventTarget.addEventListener/removeEventListener`, `Element.classList`, `Node.parentElement`, `Element.setAttribute`, `HTMLElement.style`, `Element.children`, `Node.ownerDocument`, `Document.defaultView`, `Document.createElement`, `Element.append`, `DOMTokenList.add/remove/toggle/contains`, `Element.className` (set), `Node.appendChild`, `Element.tagName`, `MessagePort.postMessage`, `HTMLElement.tabIndex` (set), `Element.firstElementChild`, `Element.remove`, `Element.removeAttribute`, `Element.getBoundingClientRect` (486), `getComputedStyle` (551), `Element.clientWidth`, `Node.textContent` (set), `Element.ariaLabel` (set, 448), `Document.hasFocus`, `Document.activeElement`, `CSSStyleDeclaration.setProperty/removeProperty`.

## Constructors and globals used

`new Proxy` 479, `new Blob` 488 (dev), `new TextDecoder` 21, `new DOMParser` 18, `new TextEncoder` 9, `new ResizeObserver` 9, `new MutationObserver` 9, `new BroadcastChannel` 3, `new AbortController` 3, `new WeakRef` 2, `new Worker` 2, `new FinalizationRegistry` 1, `new Intl.Collator` 1, `new Intl.NumberFormat` 1, `fetch` 1, `crypto.randomUUID` 19, `matchMedia` 5, `queueMicrotask` ~41, `setInterval` 8. Not seen at startup: `IntersectionObserver`, `Intl.Segmenter`, `OffscreenCanvas`, `WebSocket`, `XMLHttpRequest`, `SharedArrayBuffer`, `FontFace`.

## CSS census

| Item | Value |
|---|---|
| Stylesheets / rules | 400 / 13,758 (dev mode; many small sheets) |
| Rule types | `CSSStyleRule` 13,399; `@keyframes` 93 (+214 keyframes); `@media` 34; `@container` 6; `@supports` 2; `@property` 6; `@font-face` 2; nested declarations 2 |
| Selector features (rules matching) | child `>` 3,150; `::before/::after` 2,125; nesting `&` 1,431; `:not()` 904; `:hover` 792; `:focus-visible/within` 291; `:is()/:where()` 287; `:first/last-child` 234; attribute selectors 190; `:nth-*` 44; sibling `+`/`~` 71; `:has()` 47; `::-webkit-scrollbar` 39; `::selection/::placeholder` 9 |
| Distinct standard properties | 227 |
| Most-declared properties | `display`, `color`, `content`, `background-color`, `padding-*`, `font-size`, `width`, `height`, `align-items`, `margin-*`, `border-*-color`, `flex-shrink`, `border-*-radius`, `overflow-*`, `position`, `opacity`, `column-gap` |

CSS nesting (`&`) is used in 1,431 rules, so the parser must handle native nesting.

## Implications for the host (updates to the architecture notes)

- The minimal DOM + layout engine can be driven by a **measured target list**: ~180 DOM members now, ~227 CSS properties, block/inline/flex/absolute/relative layout, text with `nowrap`/ellipsis, borders/radius, opacity, simple transforms. Grid, sticky, fixed, filters, and masks are deferrable.
- Text input via `<textarea>` is a much easier problem than a contentEditable/IME surface; IME/composition still needs a native bridge but the DOM side is a plain text control.
- Canvas 2D can start as a tiny subset (rects, text, lines, `putImageData`).
- The cost drivers are **event dispatch**, **class/attribute churn**, and **`getComputedStyle`/`getBoundingClientRect` forced layout**: the engine must make style resolution and layout fast and incremental.

## Next trace slices

- [ ] Scripted scenarios in the same harness: type in the editor, scroll a large file, open Search and run a query, open the integrated terminal, open Settings UI, open a markdown preview (webview), open a diff.
- [ ] Production bundle (not dev mode) so counts are not inflated by module loading.
- [ ] Trace the main, shared, and extension-host processes: which Node built-ins, `process.*`, and Electron APIs are called at runtime.
- [ ] Add more instrumented interfaces (Intl, `IntersectionObserver`, `Selection`/`Range` already included; check `HTMLSlotElement`, SVG, `Animation`, `CSSStyleRule`).
