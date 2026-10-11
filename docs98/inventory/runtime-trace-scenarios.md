# Inventory — Runtime Trace: Scripted Scenarios

Follow-up to [runtime-trace.md](runtime-trace.md) (startup only). This one drives the real UI through ten steps and records which instrumented DOM/Web APIs each feature adds.

- **Taken at:** `32bbe1b8` (1.142.0), Electron 43.7.7 / Chromium 150, Linux, headless, dev mode (unbundled), 1440×900 emulated viewport.
- **Driver:** [scripts/trace_scenarios.mjs](scripts/trace_scenarios.mjs) via [scripts/run_scenarios.sh](scripts/run_scenarios.sh) (CDP synthetic keyboard/mouse input; throwaway profile and a copy of `src/vs/editor` as the workspace; nothing saved).
- **Raw data:** [data/scenarios-trace.json](data/scenarios-trace.json). Screenshots of two steps in [data/shots/](data/shots/).
- **Re-run:** `bash docs98/inventory/scripts/run_scenarios.sh <workdir>` from the repo root, after the build steps in [baseline-build.md](baseline-build.md).

## Limits (read first)

- **Same caveats as the startup trace:** dev mode inflates module-loading counts; only the instrumented subset is visible (~45 interfaces, ~35 constructors/functions, plus event interfaces added for this run); renderer process only.
- **Synthetic input is not human input.** Every step's success check passed and screenshots confirm the editor, search, terminal, settings, and diff worked. Real users produce different event streams (IME, touch, drag-and-drop, clipboard, high-DPI) that this does not cover. **Not exercised:** drag-and-drop, clipboard paste, IME/composition, context menus, extension views (marketplace, git), debugging, notebooks, custom editors, find-in-terminal, multi-window.
- **The markdown preview was blank in this run, and that was a build gap, not a headless limit.** The extension media (`npm run gulp compile-extension-media`) had not been built, so the preview's scripts returned 404. After building it the preview renders; see [runtime-trace-webview.md](runtime-trace-webview.md). Step 06 below and `data/scenarios-trace.json` come from the run *before* that fix, so only the workbench-side calls are valid for it.
- **The diff step compared the file against the clipboard**, not against another file (the palette's first match took the Enter). It still exercised the diff editor.
- The terminal runs real `bash` through `node-pty`; typed commands (`ls`, `echo hello`, `cat README.md`) produced correct output.
- Heap numbers (below) come from `performance.memory` in this run, with ~500 files open in the workspace. They are **not comparable** to the 123 MB `Runtime.getHeapUsage` figure in the startup trace (different measure, different workspace).

## What each scenario added (APIs first seen in that step)

| Step | What was done | New instrumented APIs |
|---|---|---|
| 00 ready | Cold start, 1 folder, idle | The startup set (~200 members), see [runtime-trace.md](runtime-trace.md) |
| 01 typing | New untitled file, set language TypeScript, typed ~11 lines, pressed Ctrl+Space for completion (a completion popup was not verified) | **Keyboard events**: `KeyboardEvent.{key,code,keyCode,charCode,isComposing,getModifierState,ctrl/shift/alt/metaKey}` (thousands of reads: every keystroke is inspected many times); `InputEvent.inputType`; `Event.preventDefault`. **Canvas 2D**: `fillStyle/fillRect/fillText/strokeStyle/lineWidth/moveTo/lineTo/stroke/beginPath/createImageData/putImageData/font/letterSpacing`. **Other**: `WebAssembly.instantiateStreaming`, `fetch`, `IntersectionObserver` (1), `Element.setPointerCapture/releasePointerCapture`, `HTMLInputElement.setSelectionRange/select`, `Element.replaceWith` (1,004 calls over the whole run), `insertAdjacentHTML`, `Element.getAnimations`, `Performance.getEntriesByName/clearMarks/clearMeasures`, `Worker.terminate`, `Intl.NumberFormat` |
| 02 quick open, scroll, find | Open a 2.7k-line file, PageDown ×25, wheel ×40, Ctrl+End/Home, select, Ctrl+F | `WheelEvent.wheelDeltaX/Y` (legacy WebKit), `MouseEvent.fromElement` (legacy), `Document.caretRangeFromPoint` (non-standard WebKit), `Document.getSelection`, `Selection.anchorNode`, `Range.{setStart,setEnd,selectNodeContents,getClientRects}`, `CanvasRenderingContext2D.{fillText,measureText}`, `TextMetrics.width`, `HTMLTextAreaElement.{value,select,disabled}`, `Element.childElementCount`, `Event.stopPropagation` |
| 03 search | "Disposable" across 503 files via ripgrep (4,131 results), open a result | Almost nothing new (`MouseEvent.x`, `Element.after`). The work is presumably in the search process (ripgrep), not new DOM APIs |
| 04 terminal | Open integrated terminal, run `ls`, `echo`, `cat` | **`OffscreenCanvas`** (constructed 10×), `CanvasRenderingContext2D.createLinearGradient/globalCompositeOperation`, `TextMetrics.fontBoundingBoxAscent/Descent`, `structuredClone`, `InputEvent.data`, `Event.composed`, `HTMLTextAreaElement.readOnly`, `HTMLElement.dir`, `Navigator.platform`. No WebGL |
| 05 settings editor | Settings modal, filter "font size", scroll | `HTMLSelectElement.{options,add,selectedIndex,disabled}`, `HTMLInputElement.step` |
| 06 markdown preview | Open README.md, Markdown: Show Preview | `HTMLIFrameElement.{name,sandbox,contentWindow}`, `new MessageChannel` (+ `port1/port2/close`), `crypto.subtle.digest` |
| 07 diff editor | Diff vs clipboard | `SVGElement.style` only. Nothing else new; no Worker activity was seen in this step |
| 08 explorer + palette | Tree navigation, command palette filter | Nothing new |

**Totals:** 312 distinct instrumented members/constructors/functions called across startup + all scenarios (vs ~180–200 at startup alone), so the scenarios roughly added 110. Part of that is only because the instrumented set was widened (event interfaces etc.) for this run, so treat it as an upper bound. Per-step JSON has `newApis`, `topIncrements`, and DOM stats.

## DOM/CSS after all scenarios (live, 2,700 elements)

| Item | Value |
|---|---|
| Standard CSS properties declared | **227** (unchanged from startup; the set did not grow) |
| Rules / rule types | 15,469 rules; `@keyframes` 99, `@media` 34, `@container` 6, `@supports` 2, `@property` 6, `@font-face` 2 |
| `display` | block 1,192; none 668; flex 494; inline 246; inline-block 97; contents 2; inline-flex 1; **grid 0** |
| `position` | static 1,696; absolute 726; relative 277; **fixed 1**; **sticky 0** |
| `overflow-x` | visible 2,226; hidden 428; clip 30; auto 16 |
| Flex direction | row 2,668; column 31; row-reverse 1 |
| `white-space` | normal 1,318; nowrap 1,207; pre 170; pre-wrap 5 |
| Effects (elements) | border-radius 307; `::before` content 220; z-index 150; opacity<1 110; transform 100; transition 71; contain 65; box-shadow 25; `::after` 24; will-change 3; filter/mask/backdrop-filter 0 |
| Shadow DOM | 0 |
| Canvases | 17 (editor minimap/overview, terminal, diff) |
| `contentEditable` | 0; `<textarea>/<input>` 9 |
| Max DOM depth | 50 |

## Webview architecture observed (shell only)

> Superseded by [runtime-trace-webview.md](runtime-trace-webview.md), which also covers the content frame. Kept for the record.

CDP targets after opening the markdown preview: a **service worker** and an **iframe** both on the `vscode-webview://` scheme, plus three workers and the main page. The iframe's document is a thin shell (8 elements: `html, head, 3×meta, body, script, iframe`), i.e. **the webview is an iframe containing another iframe**, with resources served via a service worker on a custom scheme. Implications: the host needs (a) a custom URL scheme with per-webview origin isolation, (b) service-worker-like interception for resource loading (or a different loader), (c) cross-frame `MessageChannel` messaging, and (d) a real HTML/CSS/JS engine for the inner content (extension-authored HTML). (The inner frame is measured in [runtime-trace-webview.md](runtime-trace-webview.md).)

## Memory (JS heap, `performance.memory`, dev mode)

After each step (MB): ready 238, typing 318, quick open 248, search 252, terminal 235, settings 256, markdown 285, diff 256, explorer 266. Peak ≈ 318 MB, steady-state ≈ 235–285 MB. This is the renderer JS heap only (not DOM/layout/GPU memory, not the other processes), with unbundled modules.

## Implications (updates to architecture notes)

1. **Surface is bounded.** ~312 members across startup + 9 features. The long tail grows slowly after startup (search, explorer, diff add almost nothing), so a host built for startup + editing + terminal + settings + webview shell covers most of what was seen.
2. **Keyboard handling needs the full legacy event model:** `keyCode`, `charCode`, `code`, `key`, `isComposing`, `getModifierState` are read thousands of times. VS Code does its own keybinding resolution from raw events, so the host must deliver accurate physical-key data.
3. **Legacy/non-standard WebKit APIs are used** (`caretRangeFromPoint`, `wheelDelta*`, `MouseEvent.fromElement`). The host must emulate them, or the call sites need patching.
4. **Canvas 2D is a real dependency** (text via `fillText`, `measureText`, `putImageData`, `OffscreenCanvas` in the terminal), though only a small subset of the API.
5. **Text selection/ranges** (`Range`, `Selection`, `caretRangeFromPoint`) are used when clicking/selecting; the editor is still `<textarea>`-driven, no `contentEditable`.
6. **Webviews are a separate, large requirement.** Now measured for markdown in [runtime-trace-webview.md](runtime-trace-webview.md); other webview types are still unmeasured.
7. **Several features depend on child processes rather than the DOM**: search (ripgrep), terminal (`node-pty` + bash), TypeScript diagnostics (the Problems count rose to 13 and later 70, presumably from tsserver in the extension host; not traced). They show up as Node/OS requirements, not renderer APIs.

## Next

- [x] Resolve the blank markdown preview: it was an unbuilt-media 404, now measured in [runtime-trace-webview.md](runtime-trace-webview.md).
- [ ] Production bundle run (non-dev) to remove module-loading noise.
- [ ] Trace the main, shared, and extension-host processes for Node/Electron APIs at runtime (the process side of the same scenarios).
- [ ] More scenarios: drag-and-drop, clipboard, IME, context menus, git view, extensions view, debugging, notebook.
