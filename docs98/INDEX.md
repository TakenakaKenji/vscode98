# vscode98 — Documentation Index

Start here. Every doc in `docs98/` is listed below with a one-line summary. Update this file whenever a doc is added, renamed, or retired.

**Resuming? Read [CHECKPOINT.md](CHECKPOINT.md) first**: current status, next steps, how to rebuild the dev environment, gotchas.

## Core project docs

| File | What it covers |
|---|---|
| [00-overview.md](00-overview.md) | What vscode98 is, why it exists, repo layout, how to work in this repo |
| [01-goal-and-scope.md](01-goal-and-scope.md) | The end goal, what "full feature set" means, what is in/out of scope |
| [02-architecture.md](02-architecture.md) | How VS Code is built today, and the target Electron-free host architecture |
| [03-targets-and-limits.md](03-targets-and-limits.md) | Win 7 → XP → 98 stages and the hard OS limits at each |
| [04-roadmap.md](04-roadmap.md) | Phased plan with status of each phase |
| [05-decisions.md](05-decisions.md) | Decision log (what we chose, why, what we rejected) |
| [06-glossary.md](06-glossary.md) | Terms: Electron, renderer, extension host, ConPTY, etc. |

## Inventory (Phase 0) — what VS Code actually uses from its host

| File | What it covers |
|---|---|
| [inventory/README.md](inventory/README.md) | Method, commands, how to re-run the scans, summary of results |
| [inventory/dom-and-web-apis.md](inventory/dom-and-web-apis.md) | DOM, CSS, and Web Platform APIs used by `src/` |
| [inventory/node-apis.md](inventory/node-apis.md) | Node.js built-in modules used, by module and layer |
| [inventory/electron-apis.md](inventory/electron-apis.md) | Electron APIs used, by process type |
| [inventory/native-modules.md](inventory/native-modules.md) | Native (C/C++) npm modules and what each does |
| [inventory/js-language-level.md](inventory/js-language-level.md) | ECMAScript level emitted/required, and engine implications |
| [inventory/baseline-build.md](inventory/baseline-build.md) | How stock VS Code was built on the dev machine, timings, what the emitted JS looks like |
| [inventory/runtime-trace.md](inventory/runtime-trace.md) | **Measured** startup trace of the renderer: which DOM/Web/CSS features are actually used (180 DOM members, 227 CSS properties) |
| [inventory/runtime-trace-scenarios.md](inventory/runtime-trace-scenarios.md) | **Measured** trace of 9 scripted feature scenarios: which extra APIs typing, search, terminal, settings, webviews, diff need (312 distinct members total) |
| [inventory/runtime-trace-webview.md](inventory/runtime-trace-webview.md) | **Measured** webview deep-dive (markdown preview): iframe-in-iframe + service worker + custom scheme, CSS/DOM actually used, requirements for the host |
| [inventory/runtime-trace-processes.md](inventory/runtime-trace-processes.md) | **Measured** Node + Electron API usage of the main process, 5 utility processes and the language-server children (119 Node functions, 102 Electron methods/events, IPC channels, native addons, env, spawned programs) |
| [inventory/baseline-bundle.md](inventory/baseline-bundle.md) | **Measured** production-bundle baseline: bundle size/time, JS level of the bundle (still ES2024 ES modules), startup time (2.4 s bundled vs 12.8 s dev) and memory (~0.84 GB PSS / 1.5 GB RSS idle, empty workspace) |
| `inventory/data/` | Raw JSON from traces and baselines (`data/baseline/`) |
| `inventory/scripts/` | The scan scripts that produced the numbers (`scan_imports.py`, `scan_electron.py`, `scan_web_and_lang.sh`, `trace_renderer.mjs`, `trace_scenarios.mjs` + `run_scenarios.sh`, `trace_webview.mjs`, process hook `node_hook.cjs` (+ `node_hook_esm.mjs`, `analyze_proc_trace.py`), shared `trace_common.mjs`/`cdp_input.mjs`; baseline: `stage_bundled_app.ts`, `run_baseline.sh`, `measure_baseline.mjs`) |

## Phase 1 spikes

| File | What it covers |
|---|---|
| [spikes/01-js-engine/README.md](spikes/01-js-engine/README.md) | **Measured** spike 1, step 1: QuickJS-ng 0.17 compiles the whole production bundle unmodified (workbench 2.8 to 3.4 s, 0.2 s from bytecode); missing `Intl`/`WebAssembly`/`structuredClone`; esbuild lowers to ES2015 but not ES5; Win 7 OK / XP-98 need a sync-layer port. Code: `parse_bench.c`, `feature_probe.js` |

| [spikes/02-node-shim/README.md](spikes/02-node-shim/README.md) | **Measured** spike 2: QuickJS-ng executes a TypeScript type-check 8.5× slower than V8 JIT (2.2× slower than V8 jitless) with identical results; the extension host, shared process, pty host and file watcher bundles boot on QuickJS-ng with ~260 lines of shim; extension host handshake and first RPC burst work. Code: `ts_bench_core.mjs`, `host/` (shim generator, globals, runner) |

| [spikes/03-extension-loading/README.md](spikes/03-extension-loading/README.md) | **Measured** spike 3: 24 of 34 built-in extensions load through `require()` and activate on QuickJS-ng (git, typescript-language-features, emmet, npm...); 4 language-client extensions stop at `child_process.fork`; ESM-only deps need pre-bundling (no sync `require(esm)`); `github` (ESM extension) needs a native resolver hook. Code: `run_ext.mjs` (RPC-speaking fake renderer), `run_sweep.sh`, `../02-node-shim/host/impl/module.js` |
| [spikes/04-webassembly/README.md](spikes/04-webassembly/README.md) | **Measured** spike 4: `onig.wasm` runs three ways on QuickJS-ng with identical results on 68,741 recorded calls (wasm3 interpreter 8× slower per call than V8 and 2.6× slower end-to-end than native; native libonig and wasm2c ≈ V8 per call); x86-32 build checked; tree-sitter (experimental, default off) not shown to run. Code: `host/` (wasm3 `WebAssembly` API, native Oniguruma, wasm2c), `tests/` |
| [spikes/05-child-process/README.md](spikes/05-child-process/README.md) | **Measured** spike 5: `child_process` (spawn/fork with IPC/exec/sync variants), `net`, `readline`, a native ES-module resolver/loader with sync `require(esm)` on QuickJS-ng (374 lines of C + ~550 of JS); real tsserver gives the same answers as Node (6.0× slower), the JSON/CSS/HTML/Markdown language servers and the git extension run; 29 of 34 built-in extensions activate with no pre-bundling; Windows event loop cannot wait on pipes/sockets. Code: `host/` (`proc.c`, `esm.c`, `impl/`), `tests/` |
| [spikes/06-rendering/README.md](spikes/06-rendering/README.md) | **Measured** spike 6: a ~210 KB pure-JS DOM + CSS + layout + software painter runs the real Monaco on QuickJS-ng with Chromium-exact geometry (4 scenarios, framebuffer identical to Node's) and reproduces ~75 % of the real workbench's boxes within 1 px (static replay); layout+paint were slow on QuickJS (fixed in spike 7). Windows/GDI not tested |
| [spikes/08-workbench-boot/README.md](spikes/08-workbench-boot/README.md) | **Measured** spike 8: the real (web) workbench boots and responds to input on our DOM/style/layout/render stack on QuickJS-ng; boot = 131 full restyle passes, 165 of 175 s are style (a perfect incremental invalidation would need 4.3 % of the restyles), ~10 s per keystroke today, peak RSS 666 to 683 MB |
| [FEATURES.md](FEATURES.md) | Feature status table (what works on the Windows host, how it is tested, what is missing); the audit that precedes any XP/98 back-port. |
| [spikes/11-windows-host/README.md](spikes/11-windows-host/README.md) | **Measured on Wine only** (not on Windows): the QuickJS host cross-built for Windows (mingw-w64, i586, 1.6 MB, imports only kernel32/user32/gdi32/msvcrt); native process/pipe layer (overlapped named pipes, CreateProcess, waitable process handles, named-pipe servers) so `child_process.fork` + IPC and `net` over pipes pass the spike 5 tests; a Win32/GDI window with a message pump inside the QuickJS loop; Windows-aware path/fs/url/os shims; the spike 10 desktop workbench renders in a window on the .exe and opens the Command Palette. Open: real-Windows verification, XP (4 Vista-only imports from QuickJS), Win9x, TCP. Includes a VM test package script |
- [spikes/12-control/README.md](spikes/12-control/README.md) — control benchmark: stock Electron VS Code (1.142 and 1.70.2) vs the vscode98 host, per interaction, startup and memory; where our time goes (style).
- [spikes/13-native-style/README.md](spikes/13-native-style/README.md) — native style engine: selector matching in C (element-tree mirror, compiled selectors, rule index), computed values in C (phase 2), the startup rule index (phase 3a: stylesheet and selector parsers in C, oracle tests in `tests/`), layered custom properties and cascade fixes; correctness checks (verify mode, fuzz) and the fixes found on the way (poll EINTR, timer exceptions, sqlite stand-in).
- [spikes/14-launch/README.md](spikes/14-launch/README.md) — launch timeline of all processes (busy/waiting per 100 ms, VS Code's startup marks; `--timeline`) and the bytecode cache for large ES modules (compiling the 42.7 MB workbench bundle was the largest piece of the launch); the sampling profiler of all processes (`QJS98_PROFILE`, `prof98.h`; report in the log and `results\profile.txt`); interaction speed (v26: box-tree disposal, collections at idle moments, per-action profile).
- [retrospective/README.md](retrospective/README.md) — retrospective and roadmap (2026-10-16): timeline of how we got here, every mistake and its correction, what worked, a playbook for moving another Electron app off Electron, and day-to-day working practices (read [05-working-practices.md](retrospective/05-working-practices.md) before starting work).
| [spikes/10-main-shim/README.md](spikes/10-main-shim/README.md) | **Measured** spike 10: VS Code's own electron-main bundle runs unmodified on QuickJS-ng with a 190-line `electron` stand-in (13 calls are no-ops), starts the shared process, file watcher, extension host and language servers (all QuickJS); the desktop workbench opens a folder, edits and saves a file, the git extension shows the branch and the `M` decoration; renderer 704 MB, the other five processes 188 MB; native addons are stand-ins, agent host crashes, nothing on Windows. Code: `host/` (stub, port relay, harnesses), shim fixes in `../02-node-shim/host/impl/` |
| [spikes/09-incremental-style/README.md](spikes/09-incremental-style/README.md) | **Measured** spike 9: incremental style invalidation (mutation-log planner, rule-set key/shape analysis, rule-set delta) with a verify oracle and a fuzzer; workbench boot 175 s → 32 s, one keystroke ~10 s → ~0.1 s, command palette 25.8 → 4.7 s, Search click 120 → 5.9 s; 0 mismatches against a full restyle on a whole boot and 650,000 fuzzed passes; 15 soundness bugs found and fixed on the way; remaining: price per restyle, rule-index rebuilds, memory. Code: `../06-rendering/host/dom/style_invalidation.js`, `layout.js`, `tests/style_fuzz.mjs` |
| [spikes/07-native-render/README.md](spikes/07-native-render/README.md) | **Measured** spike 7: layout (620 lines of C) and a display-list rasterizer (244 lines of C) as QuickJS modules, identical geometry and byte-identical framebuffers to the JS engine on 5 pages (also x86-32); workbench layout 0.4 s → 0.03 s, paint 3.1 s → 0.05 s; shows CSS selector matching (1.7 to 1.9 s warm per restyle) is the remaining bottleneck |

## Key facts to remember (quick reference)

- Electron is imported in only ~52 files (47 in `electron-main`); the renderer reaches it through one preload bridge (`src/vs/base/parts/sandbox/electron-browser/preload.ts`).
- Only 25 Node built-ins are imported in `src/vs`; hardest are `child_process`, `net`/`http`/`https`/`tls`.
- 471 CSS files (~92k lines); flexbox in 287, custom properties in 408, grid in 39.
- WebAssembly (`vscode-oniguruma`, tree-sitter) is required for syntax highlighting.
- **Runtime trace (measured):** startup uses only ~180 distinct DOM/Web members and 227 distinct standard CSS properties; layout is block/inline/flex/absolute only (no grid/fixed/sticky live); editor input is a `<textarea>`; renderer heap ~123 MB.
- **Scenario trace (measured):** startup + 9 features = 312 distinct instrumented members; editor typing needs full legacy keyboard events; terminal uses `OffscreenCanvas` + Canvas 2D (no WebGL); webviews are an iframe-in-iframe over a `vscode-webview:` scheme + service worker (content measured in `runtime-trace-webview.md`: table/list/inline layout, 144 CSS properties, KaTeX web fonts).
- **Process-side trace (measured):** the whole app calls only 119 distinct Node functions (~13 modules) and 102 Electron methods/events (incl. `webContents`/`session`); renderer↔main IPC is one multiplexed `vscode:message` channel + ~3 MessagePort handoffs; programs launched: `rg`, `git`, `tsserver`, shells. Language-server children traced: they add the `fork()` IPC channel (`process.send`) and very heavy synchronous `fs.statSync` use but few new functions.
- **Bundle baseline (measured):** the desktop bundle is 58 MB of minified ES2024 ES modules in 30 files (workbench 20.6 MB); renderer reaches a restored workbench ~2.0 s after start, of which ~1.3 s is loading the workbench bundle; idle with an empty workspace is ~1.5 GB RSS / ~0.84 GB PSS across 10 processes.
- **Spike 1 step 1 (measured):** QuickJS-ng compiles all 30 bundle files with zero syntax changes; compiling the workbench takes 2.8 to 3.4 s on a 2.1 GHz Xeon (V8 loads and runs it in 1.3 s) but only 0.2 s from precompiled bytecode; `Intl`, `WebAssembly`, `structuredClone` are missing; execution speed still unmeasured.
- **Spike 2 (measured):** QuickJS-ng is 8.5× slower than V8 JIT / 2.2× slower than V8 `--jitless` on TypeScript type-checking (same answers); Node-side bundles boot on it with ~260 lines of shim and an enumerated small API need; extension loading (`require`), `net`, `child_process`, native modules not yet tested.
- **Spike 3 (measured):** 24 of 34 built-in extensions activate on QuickJS-ng via `require()`; `require('vscode')` interception works through a patched `Module._load`; code loading per extension median 7.5 ms (max 202 ms); blocked next on `child_process.fork` (4 language servers) and on native sync-ESM/resolver hooks.
- **Spike 4 (measured):** syntax highlighting does not need a general `WebAssembly`: native Oniguruma or wasm2c-translated `onig.wasm` give identical results at about V8 speed per call; a wasm3 interpreter works but costs 2.6× (x86-64) to 4.9× (x86-32) end-to-end tokenization time vs native. Tokenizing 8,482 lines: V8 1.4 s, QuickJS+native 4.6 s, +wasm2c 4.1 s, +wasm3 12.1 s.
- **Spike 5 (measured):** `fork()` with a JSON-lines IPC channel, `spawn`, `net` and Node-style ES-module resolution (+ sync `require(esm)`, CJS interop, `registerHooks` resolve) run on QuickJS-ng with a small native layer; real tsserver is 6.0× slower than on Node (1.12 s vs 6.73 s, same answers), idle child 4 MB vs 39 MB RSS; 29 of 34 built-in extensions activate. QuickJS's Windows poll loop only waits on stdin and worker ports, so pipes/sockets need a host-owned loop there; JS UTF-8 decoding made IPC 60× slower until made native.
- Build targets are ES2024 (no downleveling today).
- Decisions (as of 2026-10-16) in [05-decisions.md](05-decisions.md): all accepted. D-003 custom host, D-004 QuickJS-ng, D-005 own DOM/CSS/layout with native layout/raster/matching, D-006 VS Code's own process model on native transports, D-008 AI/cloud out of scope, D-009 i586/x87 baseline, D-010 control benchmark as the performance yardstick, D-011 native parts behind the JavaScript reference with identical-output gates.

## Conventions

- Docs are Markdown, one topic per file, numbered for the core set.
- Measured claims (counts, file lists) say which commit they were taken at and how to reproduce them.
- Unverified claims are marked **(unverified)**.
- Status values: `not started`, `in progress`, `done`, `blocked`.
- Upstream VS Code files are not edited for docs; everything project-specific lives here or in clearly new files.
