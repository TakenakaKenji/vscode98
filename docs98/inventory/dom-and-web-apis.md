# Inventory — DOM, CSS, and Web Platform APIs

Taken at `32bbe1b8`. Source: `scripts/scan_web_and_lang.sh`. Unit: number of files in `src/vs` (non-test) matching a regex, or CSS files (471 files, ~92k lines, non-test).

> **Read [README.md](README.md) caveats first.** These are crude file-level greps. Some patterns over-match (`Animation`, `Range`, `GestureEvent`). Static counts do not show how heavily something is used at runtime. A runtime trace is the planned follow-up.

## Counts: JS-side Web APIs

| API family | Files | Needed for | Notes for a custom host |
|---|---|---|---|
| DOM Range/Selection (`getSelection`, `createRange`) | 153 | Editor, find, copy | Core to editing UI |
| Drag and drop (`DragEvent`, `dataTransfer`) | 89 | Tabs, explorer, editor | Needs native DnD bridge |
| `getBoundingClientRect` | 88 | Layout measurement everywhere | Requires a real layout engine |
| `ResizeObserver` | 65 | Responsive layout | Implementable on top of own layout |
| `queueMicrotask` | 62 | Scheduling | Engine/host feature |
| `postMessage` / `window.open` | 60 | Webviews, aux windows | |
| `fetch` | 59 | Network | Needs TLS for https |
| `ReadableStream`/`WritableStream`/`TransformStream` | 51 | Streaming | Pure-JS polyfill possible |
| `TextDecoder` / `TextEncoder` | 49 | Text I/O | Easy |
| `performance.mark/now/measure` | 43 | Telemetry/profiling | Easy |
| `AbortController` | 42 | Cancellation | Easy |
| `PointerEvent` / pointer capture | 41 | Mouse/touch input | Native input mapping |
| `getComputedStyle` | 40 | Style reads | Requires full CSS cascade |
| `Blob` / `URL.createObjectURL` | 36 | Workers, downloads | Medium |
| `Trusted Types` | 32 | Security policy | Can be stubbed |
| `getContext('2d')` (canvas 2D) | 33 | Minimap, terminal, rendering | Need canvas 2D implementation |
| `requestAnimationFrame` | 29 | Rendering loop | Easy given a frame loop |
| `contentEditable` / `EditContext` | 27 | Editor input (IME/composition) | **Hard**: text input / IME path |
| `Intl.*` (Segmenter, Collator, DateTimeFormat, ...) | 30 | Text segmentation, sort, dates | Needs ICU-like data; `Intl.Segmenter` in 4 files |
| `navigator.clipboard` / `ClipboardEvent` | 20 | Clipboard | Native clipboard bridge |
| `EventSource` | 18 | | Probably droppable |
| `BroadcastChannel` | 12 | Cross-window messaging | |
| `localStorage` / `sessionStorage` | 12 | Persistent UI state | Needs implementation |
| `MutationObserver` | 13 | | |
| `matchMedia` | 11 | Theme/contrast | |
| `indexedDB` | 8 | Storage | Could be replaced by sqlite-backed shim |
| `AudioContext` / `Audio` | 8 | Accessibility signals | Droppable |
| `OffscreenCanvas` | 7 | | |
| `WeakRef` / `FinalizationRegistry` | 7 | | Engine feature |
| webgl / webgpu | 5 | Terminal GPU renderer, optional | Droppable (DOM/canvas fallback exists in xterm) |
| `structuredClone` | 5 | | Easy |
| `CSS.supports` / `adoptedStyleSheets` / `insertRule` | 4 | Dynamic styles | Need CSSOM subset |
| `WebAssembly` | 3 | **Syntax highlighting (oniguruma), tree-sitter** | **Needs a WASM runtime** |
| `new Worker` | 3 | Web workers (editor workers, extension host worker) | Need worker model |
| `Shadow DOM` (`attachShadow`) | 23 | Webview/isolated UI | |
| `customElements` | 1 | | |
| `<iframe>` / `<webview>` | 2 / 3 | Webviews | **Needs a full HTML engine** for extension webviews |
| `MessageChannel` / `MessagePort` | 44 | IPC between workers/processes | Needed |
| `XMLHttpRequest` | 1 | | |
| `FontFace` / `document.fonts` | 0 | | Not used directly |

## Counts: CSS features (files of 471)

| Feature | Files | Layout-engine impact |
|---|---|---|
| `var(--…)` custom properties | 408 | Required (theming is built on them) |
| `display: flex` | 287 | **Required**, core layout |
| `display: block/inline/inline-block/none` | 272 | Required |
| `position: absolute/fixed/relative` | 254 | Required |
| `border-radius` | 250 | Required (rendering) |
| `cursor` | 224 | Native cursor mapping |
| `outline` | 198 | Required (focus) |
| `white-space` | 194 | Text layout |
| `:is()` / `:where()` / `:not()` | 182 | Selector engine |
| `z-index` | 161 | Stacking contexts |
| `text-overflow: ellipsis` | 151 | Text layout |
| `::before` / `::after` | 146 | Generated content (icons: codicons font) |
| `transition` / `animation` / `@keyframes` | 137 | Animation system (could be reduced) |
| `pointer-events` | 135 | Hit testing |
| `transform` (translate/rotate/scale) | 116 | Required for some UI; GDI cannot do arbitrary transforms natively |
| `calc()` | 103 | Required |
| `box-shadow` | 102 | Rendering cost on GDI |
| `text-decoration` / `letter-spacing` / `font-feature…` | 90 | Text rendering |
| `user-select` | 79 | |
| `color-mix()` / `oklch` / `lab` | 59 | Color math (can pre-compute in theme code) |
| `linear-gradient` / `radial-gradient` | 39 | Rendering |
| `display: grid` / `grid-template` | 39 | **Second layout algorithm** |
| `:has()` | 34 | Hard selector (reverse matching) |
| `@media` | 35 | Media queries |
| `overflow: auto/scroll` | 42 | Scrolling containers |
| `::-webkit-scrollbar` / `scrollbar-*` | 24 | Custom scrollbars |
| `-webkit-` prefixed properties | 114 | Several legacy props to support |
| `mask` / `clip-path` | 24 | Rendering |
| `backdrop-filter` / `filter` | 20 | Droppable on old targets |
| `will-change` / `contain` | 18 | Hints; ignorable |
| `@container` / `container-type` | 10 | Container queries (hard) |
| `position: sticky` | 5 | Scroll behavior |
| `@layer` / `@scope` / `@supports` | 4 | |
| `writing-mode` / `direction: rtl` | 2 | RTL/vertical mostly absent in UI CSS |
| `@font-face` | 1 | Codicon icon font |

## Takeaways

1. **A minimal engine must implement**: block + inline + flex layout, absolute/relative/fixed positioning, custom properties and `calc()`, a CSS selector engine (including `:not/:is/:where` and, for some UI, `:has`), generated content, scrolling, text layout (with ellipsis and `white-space`), border/radius/shadow painting, and hit-testing.
2. **Grid, container queries, sticky, masks, filters** appear in a minority of files and may be deferrable or have fallbacks.
3. **Text input is the hardest single area.** The editor uses `contentEditable`/`EditContext`-style input handling for IME and composition (27 files). Reimplementing text input natively (IMM32 on Windows) is a project in itself, especially on Win 98.
4. **Webviews** require a real HTML engine; there is no way to fake this with a minimal DOM.
5. **WASM** is required for syntax highlighting as shipped. Options: add a WASM interpreter (portable C ones exist), or replace those modules with natively compiled equivalents exposed to JS.
6. Many Web APIs (streams, `AbortController`, `TextDecoder`, `structuredClone`, observers, `BroadcastChannel`) are small and polyfillable.
