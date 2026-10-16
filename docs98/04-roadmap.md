# 04 — Roadmap

Status values: `not started`, `in progress`, `done`, `blocked`.

## Phase 0 — Setup and inventory — `done` (2026-10-12)

| Item | Status |
|---|---|
| Fork cloned, remotes configured | done |
| Project docs (`docs98/`) | done |
| Inventory pass 1 (static scans of `src/vs`): DOM / CSS / Web APIs | done → [inventory/dom-and-web-apis.md](inventory/dom-and-web-apis.md) |
| Inventory pass 1: Node built-ins | done → [inventory/node-apis.md](inventory/node-apis.md) |
| Inventory pass 1: Electron APIs | done → [inventory/electron-apis.md](inventory/electron-apis.md) |
| Inventory pass 1: native modules | done (needs `npm ci` to verify) → [inventory/native-modules.md](inventory/native-modules.md) |
| Inventory pass 1: JS language level | done (needs a real build to verify) → [inventory/js-language-level.md](inventory/js-language-level.md) |
| Inventory pass 2: built-in `extensions/`, `build/`, finer CSS inventory | not started; not needed so far (the runtime traces and the engine's own `missing`/`unsupported` reports took its place) |
| Inventory pass 3: runtime tracing of a real VS Code session | in progress: renderer startup + scripted scenarios done → [runtime-trace.md](inventory/runtime-trace.md), [runtime-trace-scenarios.md](inventory/runtime-trace-scenarios.md); markdown webview measured → [runtime-trace-webview.md](inventory/runtime-trace-webview.md); main + 5 utility processes measured → [runtime-trace-processes.md](inventory/runtime-trace-processes.md); language-server children done; production bundle done → [baseline-bundle.md](inventory/baseline-bundle.md); other webview types (notebooks, custom editors) not traced |
| Baseline: build stock VS Code on this machine | done: build, headless launch, production bundle, startup and memory → [inventory/baseline-build.md](inventory/baseline-build.md), [inventory/baseline-bundle.md](inventory/baseline-bundle.md); the per-interaction control against stock Electron came later → [spikes/12-control/](spikes/12-control/README.md) |
| Deepen git history / fetch upstream tags | not started |
| Windows build/test environment (VM or machine) | done: cross-build from Linux (mingw-w64), Wine in the sandbox, the owner's Windows 7 Pro VM (spike 11, rounds 1 to 9) and a real Windows 7 laptop (round 10 on) |

**Exit criterion:** we can state, with data, the size of the DOM/CSS/Node/Electron surface the host must provide.

## Phase 1 — Feasibility spikes — `done` (2026-10-12; exit criterion met 2026-10-16: D-004, D-005, D-006 accepted)

Small experiments to de-risk the three components before committing.

| Spike | Question |
|---|---|
| JS engine (spike 1) | Can QuickJS(-ng) (or another engine) load the compiled workbench bundle? How slow? What ES features are missing? **Step 1 done (compile-only):** all 30 bundle files compile unmodified, workbench in 2.8 to 3.4 s (0.2 s from precompiled bytecode); gaps are `Intl`, `WebAssembly`, `structuredClone`; ES2015 is the lowering floor → [spikes/01-js-engine/](spikes/01-js-engine/README.md). **Step 2 done:** QuickJS-ng is 8.5× slower than V8 JIT and 2.2× slower than V8 `--jitless` on a TypeScript type-check with identical results; the extension host, shared process, pty host and file watcher bundles boot on QuickJS-ng with ~260 lines of shim → [spikes/02-node-shim/](spikes/02-node-shim/README.md) |
| WebAssembly (added, spike 4) | Syntax highlighting needs WASM (`vscode-oniguruma`, tree-sitter) and QuickJS has none: embed a WASM interpreter (e.g. wasm3) or replace those packages with native bindings? **Done:** all three routes (wasm3 interpreter, native libonig, wasm2c-translated `onig.wasm`) give identical results on 68,741 recorded calls plus an edge-case trace, on x86-64 and x86-32. Native/wasm2c are about V8 speed per call; wasm3 is 8× slower per call and 2.6× to 4.9× slower for tokenization end to end. Tree-sitter is experimental/default-off and was not shown to run on wasm3 (dylink needs shared memory/table imports the spike API lacks) → [spikes/04-webassembly/](spikes/04-webassembly/README.md) |
| Rendering (spike 6) | Can a minimal DOM + flexbox + GDI renderer draw a simple Monaco editor view? **Done for the engine, not for GDI:** a pure-JS DOM + CSS + layout + software painter runs the real Monaco on QuickJS-ng with Chromium-exact geometry and reproduces ~75 % of the real workbench's boxes within 1 px (static replay); on QuickJS the JS layout/paint were slow, which **spike 7** fixed by moving them to C with identical output (layout 15×, paint 60× faster); the remaining cost is style resolution (selector matching); SVG, shadows, kerning, `env()`, rotation, Canvas 2D and Windows not done → [spikes/06-rendering/](spikes/06-rendering/README.md), [spikes/07-native-render/](spikes/07-native-render/README.md); **spike 8** then booted the real web workbench on this stack (works; 131 full restyles per boot) and **spike 11** ran the host on Windows (Wine-tested; VM verification pending) → [spikes/11-windows-host/](spikes/11-windows-host/README.md); **spike 10** then booted the **desktop** workbench with VS Code's own electron-main on QuickJS behind a thin `electron` stand-in (folder, edit, save, extension host, git all work; renderer memory and Windows remain) → [spikes/10-main-shim/](spikes/10-main-shim/README.md); **spike 9** made the style pass incremental (boot 175 s → 32 s, one keystroke ~10 s → ~0.1 s, result checked against a full restyle on a whole boot and 650,000 fuzzed passes) → [spikes/08-workbench-boot/](spikes/08-workbench-boot/README.md), [spikes/09-incremental-style/](spikes/09-incremental-style/README.md) |
| Node shim | Can the extension host boot on a minimal `fs`/`child_process`/`net` shim? **Spike 3 added:** 24 of 34 built-in extensions load via `require()` and activate on QuickJS-ng (4 more load fully and stop at `child_process.fork` for their language server) → [spikes/03-extension-loading/](spikes/03-extension-loading/README.md). **Spike 2 had answered:** yes to the point of the renderer handshake and first RPC burst, with `fs`/`path`/`os`/`events`/logger shims only; `require`/extension loading, `net`, `child_process` and native modules are still untested **Spike 5 (child processes, 2026-10-12):** `child_process` (spawn/fork+IPC/exec/sync), `net`, `readline` and a native ES-module resolver/loader with sync `require(esm)` on QuickJS-ng; tsserver, the JSON/CSS/HTML/Markdown servers and the git extension run; 29 of 34 built-in extensions activate. Linux only; the Windows loop cannot wait on pipes/sockets → [spikes/05-child-process/](spikes/05-child-process/README.md) |
| Build | Can we produce a downleveled, single-bundle build of the workbench? Partly answered by spike 1: esbuild lowers the workbench to ES2015 cleanly, ES5 is impossible; behavior of lowered code unverified. **Not needed so far:** QuickJS-ng runs the ES2024 bundles unmodified; revisit only if an engine below ES2024 is ever needed |
| Control benchmark (spike 12) | How far is the host from stock Electron VS Code on the same machine? **Done 2026-10-15:** 3 to 23 times slower per interaction, 8 to 18 times slower to start, 20 to 25 % less memory; style 65 to 87 % of every slow interaction → [spikes/12-control/](spikes/12-control/README.md) |
| Native style engine (spike 13) | How much of the style cost can move to C? **Phase 1 done 2026-10-16:** selector matching in C plus computed-value fixes in JavaScript; interactions 1.6 to 4.4 times faster, now 2.4 to 8.6 times Electron; phase 2 (computed values in C) open → [spikes/13-native-style/](spikes/13-native-style/README.md) |

**Exit criterion:** decisions D-004 (JS engine), D-005 (render strategy), D-006 (process/IPC model) recorded in [05-decisions.md](05-decisions.md).

## Phase 2 — Win 7 host — `in progress` (functionally close; performance is the main gap)

Implement components A, B, C to the point where VS Code starts without Electron on Windows 7 and meets the Win 7 success criteria in [01-goal-and-scope.md](01-goal-and-scope.md). The spikes turned into this phase directly: packages v4 to v15 were tested on the owner's Windows 7 VM and laptop ([spikes/11-windows-host/README.md](spikes/11-windows-host/README.md), rounds 1 to 10).

| Win 7 success criterion | State (2026-10-16) |
|---|---|
| Starts without Electron | done: one i586 exe + JS, nothing to install; ~20 s to load on the laptop (v14) |
| Opens a folder | done (laptop) |
| Edits and saves files | editing confirmed on the laptop; save covered by `scenario_editor` (Linux), not separately reported from the laptop |
| Runs the terminal | partial: cmd.exe over pipes (no ConPTY on Windows 7), local echo; Ctrl+C not verified; not reported from the laptop |
| Loads at least the built-in extensions | done: 86 built-in extensions in the package, extension host at low priority |

| Work item | State |
|---|---|
| Interaction latency | 2.4 to 8.6 times Electron on the sandbox (spike 13); laptop numbers for v15 pending |
| Startup | ~20 s on the laptop; first style pass ~2.5 s on the sandbox, mostly building the index of 13,296 rules (cached index is the next candidate) |
| Computed style values in C | spike 13 phase 2, not started |
| Feature gaps | see [FEATURES.md](FEATURES.md): debugging and timeline not tested, Shadow DOM, native `<select>` popup, gradients, grid/float/table layout |
| Real-hardware control benchmark | proposed (AutoHotkey input-to-pixel timer), not built |

## Phase 3 — Windows XP — `not started`

Retarget toolchain and APIs to XP; replace anything Vista+; document gaps. Known so far (spike 11): the mingw-w64 build can target XP (`WINVER=0x0501`), but QuickJS-ng imports four Vista+ functions (`InitOnceExecuteOnce` and the condition-variable APIs) that must be replaced; ripgrep needs an old enough build (13.0.0 i686 already, because newer ones need Windows 8 APIs).

## Phase 4 — Windows 98 — `not started`

Retarget to the Win9x API set (unicows, no IOCP, etc.); fill in the feasibility table in [03-targets-and-limits.md](03-targets-and-limits.md) with hard-limit evidence.

## Cross-cutting tracks (run alongside phases)

- Upstream sync strategy (how often to merge `upstream/main`, or pin a base version).
- Performance budget (startup time, memory) per target, measured with the control benchmark (D-010).
- Build/packaging/installer per target.
- Test strategy: the 11 scenario suites (`10-main-shim/host/scenario_*.mjs`), oracles and verify modes for every engine optimisation (D-011), the style fuzz, a package boot under Wine before every send, then the owner's real-hardware round ([retrospective/05-working-practices.md](retrospective/05-working-practices.md)).
