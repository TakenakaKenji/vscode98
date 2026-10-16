# 1 — Timeline: how we got here

From a fork of VS Code 1.142 (2026-10-11) to an Electron-free VS Code that runs on a real Windows 7 laptop (package v15, 2026-10-16). Every step links to the document that has the details. Unless noted, measurements are from the Linux sandbox (2.1 GHz Xeon, 4 vCPU).

## Phase 0: inventory and baseline (10-11 to 10-12)

| Step | What we learned |
|---|---|
| Static scans of `src/vs` ([inventory/](../inventory/README.md)) | Electron is imported in ~52 files, 47 of them in `electron-main`; the renderer reaches it only through one preload bridge. 471 CSS files (flex in 287, custom properties in 408, grid in 39). |
| Stock build, headless launch, runtime traces (renderer + 9 scenarios, then every process) | ~312 DOM/Web members, 227 CSS properties; 119 Node functions in ~13 modules; 102 Electron methods/events; language servers need `child_process.fork` with IPC. |
| Production bundle baseline ([baseline-bundle.md](../inventory/baseline-bundle.md)) | 30 JS files, 58 MB of ES2024 modules (workbench 20.6 MB); ready in 2.4 s bundled vs 12.8 s dev; ~65 % of renderer time is loading the bundle; idle 838 MB PSS / 1484 MB RSS. |

## Phase 1: feasibility spikes (10-12)

All of spikes 1 to 11 were built in one long day; each answered one question with a measured yes/no.

| Spike | Question | Answer |
|---|---|---|
| [1 JS engine](../spikes/01-js-engine/README.md) | Does QuickJS-ng compile the bundle? | Yes, all 30 files unmodified; workbench compiles in 2.8 to 3.4 s, bytecode reload 11 to 16 times faster. Missing `Intl`, `WebAssembly`, `structuredClone`, `TextEncoder`, `URL`, timers. ES5 lowering impossible, ES2015 fine. |
| [2 execution + Node shim](../spikes/02-node-shim/README.md) | How fast, and what does the Node side need? | 8.5 times slower than V8 with JIT, 2.2 times slower than jitless, identical results. All four Node-side bundles start on ~260 lines of shim with recording stubs. |
| [3 extensions](../spikes/03-extension-loading/README.md) | Do built-in extensions load via `require()`? | 24 of 34 activate on a 120-line CommonJS loader and a fake renderer. |
| [4 WebAssembly](../spikes/04-webassembly/README.md) | Oniguruma without `WebAssembly`? | Native libonig (12 µs/call) or wasm2c, not an interpreter (wasm3 81 µs/call). Byte-identical tokens. |
| [5 child processes](../spikes/05-child-process/README.md) | `fork` with IPC, `net`, ES-module resolution? | 374 lines of C + ~550 of JS: tsserver identical to Node, 29 of 34 extensions activate, 0 fail. |
| [6 rendering](../spikes/06-rendering/README.md) | Can our own DOM/CSS/layout/painter run Monaco? | Yes: every Monaco box within 0.5 px of Chromium; the workbench replay mostly right. Slow: 7.3 s style+layout on QuickJS. |
| [7 native render](../spikes/07-native-render/README.md) | Layout and raster in C, identical? | Yes, byte-identical; layout ~15 times, paint ~60 times faster. **Corrected spike 6:** style, not layout, was 90 % of the time. i586/x87 baseline binary + integer rasterizer (D-009). |
| [8 workbench boot](../spikes/08-workbench-boot/README.md) | Does the real (web) workbench boot? | Yes, and it responds, but boot 175 s (165 s style, 131 full restyles) and ~10 s per keystroke. |
| [9 incremental style](../spikes/09-incremental-style/README.md) | Incremental restyle that never differs from a full one? | Planner + shapes + rule-set delta + oracle + fuzzer: boot 175 → 32 s, keystroke ~10 s → ~0.1 s, 0 mismatches in 650,000 fuzzed passes (15 soundness bugs found on the way). |
| [10 main shim](../spikes/10-main-shim/README.md) | The desktop workbench without Electron? | VS Code's own electron-main runs unmodified on a ~190-line `electron` stub; every process on QuickJS; open folder, edit, save, git all work. |
| [11 Windows host](../spikes/11-windows-host/README.md) | Windows 7, 32-bit, real window, nothing to install? | mingw-w64 i586 exe (1.6 MB, kernel32/user32/gdi32/msvcrt only), overlapped-pipe process layer, GDI window. Everything passes under Wine; the self-test passes on a real Windows 7 VM. |

## Real Windows 7: rounds with the owner (10-13 to 10-15)

The owner tested each package on a Windows 7 VM (later a real Windows 7 laptop) and reported timings; each round fixed what the report showed. Details per round: [11-windows-host/README.md](../spikes/11-windows-host/README.md).

| Round / package | Owner's report | Root cause → fix |
|---|---|---|
| first desktop runs | blank window; idle UI repainting 12 times a second | Linux font paths (Wine had resolved them) → bundled fonts; `WM_PAINT` re-entered painting → no repaint on paint/focus events |
| 1 (v4, v5) | clicks work, typing and selecting do nothing, file text after 30 s | paint only on `__dirty`; `Node.prototype` lacked node-type constants (Monaco's hit test failed inside a swallowed `try`); `caretRangeFromPoint`; pointer/mouse event order |
| 2 (v6) | 51 s to open, event loop blocked 45 s, Enter dead | `js_load_file` quadratic on the Windows heap (1775 ms → 37 ms for 15 MB); 15.6 ms timer tick → `timeBeginPeriod(1)`; control characters dropped. Also: AI UI was half the boot → seeded settings (D-008) |
| 3 (v7 → v8) | opens in 10 s; drag laggy, F1 1 to 2 s | per-frame layer `calloc` → pooled layers; packed style cache; faster CSS/selector parsers |
| 4 (v8 → v9) | drag still slow | O(n) hit testing; style-only passes keep the previous layout |
| 5 (v9) | Ctrl+letter dead, menus broken | empty `native-keymap` stub; `zoom` computed as ""; fixed boxes kept ancestor clips; top-layer paint/hit order |
| 6 (v10 → v12) | "every feature has to work first" | feature audit with scripted scenarios: text controls, stacking, `<select>`, DOMPurify, terminal over pipes, drag and drop, selection, zoom, packaging fixes |
| 7, 8 (v12) | no syntax highlighting | no `WebAssembly` → native Oniguruma in the host; **and** `vscode-textmate` missing from the package |
| 9 (v12 → v13) | **"unusable"**: over a minute to open, 5 s per context menu, over a minute for a new file | 2048² SVG raster (9.3 s) → 256 px cap; 86 extensions → 10 processes on a 2 GB machine → extension host at low priority; z-index stacking order |
| 10 (v13 laptop → v14) | ~25 s load, 1 s caret, 15 to 20 s for a new file (or only after clicking around), caret at line end | overlapped pipe writes flushed only by the next write; inline-box caret offset; shell functions |

## Control benchmark (10-15)

The owner pointed out that stock VS Code 1.70.2 on the same laptop was much faster and asked for a real control. [Spike 12](../spikes/12-control/README.md): stock Electron VS Code 1.142 and 1.70.2 driven by the same actions as our host, 2 CPUs each. Result: **3 to 23 times slower per interaction, 8 to 18 times slower to start, 20 to 25 % less memory; style was 65 to 87 % of every slow interaction.**

## Native style engine (10-16)

[Spike 13](../spikes/13-native-style/README.md): selector matching in C (element-tree mirror, compiled selectors, the rule index), plus layered custom properties, a monotonic cascade and a cheap layout-change check in JavaScript. Full restyle 585 → ~130 ms with identical output. **Per interaction 1.6 to 4.4 times faster than spike 12, now 2.4 to 8.6 times Electron.** On the way: the Linux host's random "exit code 0" (poll `EINTR`), exceptions in timers ending the event loop, and a broken sqlite stand-in were found and fixed. Package v15.

## Where we are

- Works: nearly every feature in [FEATURES.md](../FEATURES.md) in scenarios; the owner confirmed boot, editing, explorer operations, menus and reveal-in-explorer on the laptop (v14).
- Slow: interactions are 2.4 to 8.6 times Electron; startup ~20 s on the laptop (the first style pass alone is ~2.5 s on the sandbox, mostly building the index of 13,296 rules).
- Not done: computed style values in C (phase 2), a cached rule index for startup, XP/98 (Vista-only imports in QuickJS), ConPTY-free terminal details, debugging, Marketplace.
- Docs that had lagged the work were brought up to date on 2026-10-16: D-003 to D-006 accepted (with D-005's "no grid/float/table" claim corrected) and D-010/D-011 recorded in [05-decisions.md](../05-decisions.md); Phases 0 and 1 marked done and Phase 2 in progress with its success criteria in [04-roadmap.md](../04-roadmap.md); the Windows 7 column of the feasibility table in [03-targets-and-limits.md](../03-targets-and-limits.md) filled in; the performance row of [FEATURES.md](../FEATURES.md) updated.
