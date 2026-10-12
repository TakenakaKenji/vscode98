# Spike 8 — booting the real workbench on our own DOM, style, layout and renderer

**Question** (D-003, D-005): everything so far was measured on parts (Monaco alone, a captured snapshot of the workbench). Does the real workbench start on the engine built in spikes 6 and 7, what breaks, and what does a running workbench cost?

- **Host:** `qjs-spike7` (QuickJS-ng 0.17.0, x86-64, spike 5/7 host) with the spike 6 DOM/CSS engine, the spike 7 native layout and integer rasterizer. Intel Xeon @ 2.1 GHz, 4 vCPU, Linux, headless, 1280×800, framebuffer written to a PPM.
- **What was booted:** the **web** workbench (`vs/code/browser/workbench/workbench.js`, bundled with the repo's own `build/next` bundler, target `server-web`), **not the desktop one**. The desktop workbench needs a main process (Electron IPC, window config, shared process, file service, ...) that does not exist yet; the web workbench runs the same UI code (parts, editor, views, quick input, chat) with browser-style services instead. That makes this a test of the DOM/CSS/layout/render side, which is what the engine decision needs. A desktop boot needs a main-process shim and is a separate piece of work.
- **Nothing ran on Windows.** No extension host, no WebAssembly, no real file system: see "Gaps".

## Verdict

1. **The real VS Code workbench boots and works on our stack.** After the page loads: title bar, activity bar, side bar views, editor area with the Welcome page, the Chat view, status bar, the modal onboarding dialog and the quick input all render (see `results/*.png`); 963 elements; the activity bar, the F1 command palette, the dialog close button and typing into a Monaco editor (the chat input) respond to synthetic mouse and keyboard events. Importing the 41 MB bundle takes 5.5 to 5.8 s on QuickJS-ng; the workbench's own JavaScript is not the problem (about 1 s of execution outside module load, style and layout).
2. **Style resolution is the problem, and it is a design problem rather than a speed problem.** Boot triggers **131 layout passes**, and each one restyles the whole tree (about 1.3 s per pass on QuickJS): **165 s of the 175 s boot are style, 3.7 s layout (native), 0.04 s paint.** The workbench reads layout after almost every DOM change, as browsers expect; browsers answer with incremental invalidation. Measured from the mutation log: a perfect incremental invalidation would have restyled **4,139 elements instead of 97,245 (4.3 %)**; 108 of the 131 passes touch 25 elements or fewer, 17 touch none.
3. **Interaction costs the same way.** Typing one character into a Monaco editor causes 4 to 6 layout passes of about 1.5 s each (**about 10 s per keystroke today**), where a perfect invalidation needs to restyle about 16 elements. Opening the Search view: 49 passes, 120 s, against about 2,000 ideal element restyles. Rule of thumb: 150 to 300 times fewer restyles are needed than are done.
4. **Memory is a second problem.** RSS is 222 MB after loading the bundle (of which the compiled workbench is ~86 MB, spike 1) and **666 to 683 MB at the end of boot**: more than 440 MB comes from running the 131 full passes on 963 elements (per-pass garbage and caches; not yet broken down). The oldest target has 128 MB. This needs its own spike.
5. **The CSS and API surface is bigger than spike 6 assumed.** `display: grid` is used (124 times) and floats (349 times) in this workbench: both unsupported by the layout engine, along with a list of browser APIs (below). Everything found so far is a gap in our engine, not in VS Code.

## Results

Boot (QuickJS-ng, native layout + integer rasterizer, x86-64):

| | |
|---|---|
| Import of the 41 MB bundle | 5.5 to 5.8 s (RSS 222 MB) |
| Time until the DOM stops changing | 175 s |
| Layout passes | 131 (min 23, max 983 elements) |
| Style / layout (C, incl. packing) in those passes | 164.9 s / 3.7 s (pack 2.7 + C 0.35 + copy back 0.14) |
| Paint of the final frame | 34 to 47 ms |
| With the JavaScript layout instead of native | 215 s (all 131 passes) |
| Peak RSS | 666 to 683 MB |

What triggered the passes (all 131 together): 2,253 node insertions, 339 removals, 2,340 `class` changes, 1,990 inline `style` changes, 2,817 other attribute changes. The estimate counts, per pass, the subtree of every element whose class/attribute changed or that was inserted, the children of every parent that gained or lost a child, and the element itself for inline style changes; it ignores sibling combinators and `:has()` (rare in the workbench's CSS), so treat 4.3 % as a lower bound of the right order, not a promise.

Scripted interaction after boot (`host/scenario_basic.mjs`, full log in `results/scenario-run.txt`):

| Action | Layout passes | Time (style + layout) | Element restyles done / ideal |
|---|---|---|---|
| close the onboarding dialog (click X) | 14 | 24.7 s | 13,223 / 470 |
| Ctrl+N (focus was in the chat input, which handled it) | 25 | 45.7 s | 23,082 / 529 |
| type `c` (first character) | 10 | 15.7 s | 9,222 / 159 |
| type `o`, `n`, `s`, `t`, ` `, `x` (each) | 6 | 8.6 to 10.7 s | 5,535 / 16 to 18 |
| F1 (command palette opens, 1,421 elements) | 14 | 25.8 s | 15,155 / 793 |
| Escape | 2 | 5.3 s | 2,842 / 141 |
| click Search in the activity bar | 49 | 119.8 s | 73,099 / 2,063 |

The typed text arrives in the editor (`"const x"`), through the real key handling of the workbench and Monaco.

## What had to be added or fixed (all in this repo, spikes 2, 6 and 7 files, plus `host/`)

- **Harness** (`host/`): `boot_qjs.mjs` (QuickJS; `boot_node.mjs` is a faster, not feature-equivalent Node twin used for first discovery), `web_shims.js` (page built from the product's own `workbench.html`, relative `url()`s in the stylesheet made absolute so the codicon font loads, browser APIs below), `boot_common.js` (stabilization loop, pass statistics), `scenario_*.mjs`, `build_web.sh` (bundle), `tests/run_boot.sh`.
- **Browser APIs that were missing in the QuickJS host and are now shimmed:** `performance.mark/measure/getEntries*`, `PerformanceObserver`, `AbortSignal` statics, `fetch/Headers/Request/Response` (files under `<base>/out/` from disk, everything else "offline"), `Blob/File/FormData`, `BroadcastChannel`, `MessagePort`, `Worker/SharedWorker/XMLHttpRequest/WebSocket` stubs that fail cleanly, `URL` with a path as base (`import.meta.url`), `HTMLCollection.item()`, window as the last node of event paths (window `keydown`/`focus` listeners never ran before).
- **Host change** (`render.c`): QuickJS **exits the process on any unhandled promise rejection**; browsers log and carry on. A host tracker now forwards rejections to `globalThis.__rejection` and the harness turns them into `unhandledrejection` events. Without this the first benign `Canceled` rejection ended the run.
- **Other:** QuickJS's main-module top-level `await` loop stalls for seconds when an event loop timer is pending (hit by running the harness at top level); running it inside an async function fixed it. Layout-pass bookkeeping (`__passStats`, `__dirtyLog`) records what made each pass necessary.

## Gaps and open items found

| Gap | Effect observed |
|---|---|
| No incremental style/layout | boot 175 s, ~10 s per keystroke; the main finding |
| Memory | 666 to 683 MB peak |
| `display: grid` (124 uses), floats (349) unsupported by layout | affected areas not examined |
| No `WebAssembly` in this host build | TextMate tokenization (onig.wasm) not exercised; spike 4 has the engine side |
| No `Worker`, no iframes | extension host (web worker in an iframe), editor/tokenization workers not running; built-in extensions not loaded |
| No `indexedDB` | the workbench falls back to in-memory state, with error logs |
| Keyboard layout detection (`import()` of `/out/...` module) fails, 32 file-system-provider errors for `file:///.copilot/...` | logged, not blocking |
| Chat welcome text shows `<p>AI responses may be inaccurate</p>` literally | an HTML-sanitization or `innerHTML` path in our DOM is wrong |
| Painter gaps from spike 6 (rounded borders, shadows, outlines, SVG) | visible as square corners and missing shadows |
| Desktop workbench not booted | needs a main-process shim (IPC channels, window configuration, services) |

## Reproduce

```bash
bash docs98/spikes/08-workbench-boot/host/build_web.sh /tmp/out-web                # ~20 s, needs the repo's node_modules
bash docs98/spikes/07-native-render/host/build.sh /tmp/s7                           # host binary
QJS7=/tmp/s7/qjs-spike7 bash docs98/spikes/08-workbench-boot/tests/run_boot.sh /tmp/out-web /tmp/boot.ppm            # boot, ~3 minutes
QJS7=/tmp/s7/qjs-spike7 bash docs98/spikes/08-workbench-boot/tests/run_boot.sh /tmp/out-web /tmp/boot.ppm basic      # + scripted interaction, ~8 minutes
```

## What this means for the decisions

- **D-003 (custom host instead of Electron): supported.** The unmodified workbench UI code runs on our DOM/CSS/layout/paint stack and reacts to input. The remaining distance to a product is mostly engineering (APIs, CSS features, services), not an unknown.
- **D-005 (render stack): the next work is style invalidation, not more native code.** Incremental restyle driven by the mutation log (the log used for the numbers here is already collected) combined with a fast matcher is worth roughly two orders of magnitude; native layout and rasterization (spike 7) are already no longer visible in the profile.
- **Memory (128 MB target):** needs measurement per component (bytecode, JS heap, DOM, style data) and a design that does not rebuild the 16,758-rule index and all style objects on every pass.
- **Still untested:** the desktop workbench, extensions, Windows, anything on the target CPUs.
