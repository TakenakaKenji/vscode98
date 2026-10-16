# 3 — What worked (techniques worth reusing)

## Ask one question per spike, answer it with a number

Each spike README opens with a **Question** and closes with a measured **Answer** and an **Open** list. That kept 13 spikes comparable, made it obvious when a later spike corrected an earlier claim (spike 7 on spike 6), and gave the checkpoint a one-line summary per step. Keep the template.

## Oracles everywhere: identical output as the gate

| Oracle | Guards | Where |
|---|---|---|
| Same JavaScript on Node and on QuickJS, same answers | engine and Node shims | spikes 2, 3, 5 (`run_node`/`run_qjs`, tsserver, language servers) |
| Headless Chromium as ground truth (box geometry dumps, screenshots) | the JavaScript DOM/CSS/layout | spike 6 (`capture_workbench`, `replay_compare.sh`) |
| The JavaScript implementation as oracle for the C one (byte-identical geometry and framebuffers) | `layout.c`, `render.c` | spike 7 (`native_compare.sh`) |
| Record a real call trace, replay it against each implementation | Oniguruma variants | spike 4 (`tokenize_bench.mjs --record`, `replay_bench.mjs`) |
| Verify modes that run both paths on every element | incremental style (`__verifyStyles`), packed style cache (`__packVerify`), style-only passes (`__verifyStyleOnly`), native matcher (`--style verify`) | spikes 9, 11, 13 |
| Differential parser tests (old and new parser, identical output) | CSS and selector parsers | round 3 |
| Randomised fuzzer against a full restyle | incremental style; native matcher (`FUZZ_NATIVE=1`) | `09-incremental-style/tests/style_fuzz.mjs` (650,000 passes in spike 9; 5,000 passes / 91,310 elements in spike 13) |
| Layout dump + pixels of the captured workbench before vs after (`cmp`) | any style/cascade refactor | `run_replay_qjs.mjs --dump --ppm` (spike 13) |

Exactness took discipline in C: the same order of floating-point operations, `-ffp-contract=off`, x87 precision set to 53 bits, half-even rounding, stable sorts.

## Let the real app tell you what it needs

- **Runtime traces before writing anything** (DOM members, CSS properties, Node and Electron calls per process).
- **Recording lenient stubs**: a callable Proxy that logs every call and returns another stub; run the real code, read the log, implement what it touched (`gen_shims.mjs`, `ELECTRON_STUB_LOG`). Spike 10 sized the whole Electron surface this way: 10 APIs needing real behaviour, 13 calls that can be no-ops.
- The engine reports every unsupported CSS feature and missing DOM member it meets (`unsupported`, `missing` maps).
- One fresh process per item for sweeps (`run_sweep.sh` over 34 extensions).

## Keep the app unmodified; replace the platform under it

The biggest structural win. VS Code's own bundles run unchanged: the workbench on our DOM, electron-main on an `electron` stub, the extension host and language servers on the Node shims. Native addons became JavaScript stand-ins (SQLite as JSON, file watcher by polling, keymap, pty over pipes); WebAssembly packages became native bindings behind the same API (Oniguruma). Nothing in `src/` had to change, so upstream updates stay possible.

## Make the style system incremental and cheap, in that order

1. **Incremental invalidation** with a planner over the mutation log and an oracle (spike 9: boot 175 → 32 s, keystroke ~10 s → ~0.1 s). Pass count first.
2. **Cheaper per element**: bucketed rule index with rarest-class and `:is()` keys, an ancestor Bloom filter, in-place index updates (rounds 2 and 3).
3. **Native where the profile says**: selector matching in C behind the same interface (spike 13: ~270 µs → 12 µs per element).
4. **Then the JavaScript that remains**, by profiling phases of `computeStyle` (layered custom properties, monotonic cascade, a cheap layout-change check): full restyle 325 → ~130 ms.

## Debugging techniques that found root causes

- Trace switches on every hop of the IPC with timestamps (`--debug-ipc 1`, `VSCODE98_TRACE_IPC`, `VSCODE98_TRACE_PIPE`, `UTIL_TRACE`); request ids followed end to end found the Windows write-queue stall.
- `strace -f --seccomp-bpf -k -e trace=exit_group`: a C stack of a process exit with almost no overhead, so a timing race still reproduces.
- A debug build of a library (`quickjs-libc.c` printing why `js_std_loop` returned) instead of guessing from JavaScript.
- Status lines with process-tree memory and periodic BMP screenshots in window mode: the owner's log alone was enough to find the idle repaint loop.
- Micro-benchmarks (`bench.js`, `bench2.js`) to tell machine speed from host bugs.
- Profiling a copy of the sources with phase timers (`mkprof.py`) and a repeatable full-restyle microbenchmark on a captured workbench (`--restyle N`).

## Scenario rigs as the regression suite

`10-main-shim/host/scenario_*.mjs` drive the real UI through the same input path as the window (`input_driver.js`) and check DOM state; they run headless on Linux and under Wine. 11 suites (inputs, explorer, search, editor, settings, tour, lang, misc, ui, webview, more), PASS/FAIL per check, plus latency (`scenario_lat`), control (`scenario_ctl`) and startup (`scenario_start`) measurements.

## The control benchmark

Same actions on stock Electron and on our host, from input event to the DOM state that shows the result, same CPU limit, median of rounds, with a style/layout/paint/event split on our side (`12-control/`, `scenario_ctl.mjs --split 1`). It turned "it feels slow" into ratios per action and showed where to work.

## Working with a remote owner on real hardware

- A self-contained package per round (zip split into 14 MB parts, `join-parts.cmd` with SHA256), a `run-desktop.cmd` that writes `results\desktop.txt` and screenshots.
- The owner reports the same list of timings each round; each round is written up (report → cause → fix → effect) in `11-windows-host/README.md`.
- Scope cut agreed early (D-008: no AI features on old Windows); seeded settings make the package start in that configuration.

## Cross-building and portability checks

One i586/x87 binary for the CPU floor with `check_isa.sh` (0 SSE/MMX/CMOV) and `check_imports.sh` (only DLLs present on Windows 7 / XP), cross-built from Linux with mingw-w64; the same C modules (`render.c`, `layout.c`, `style.c`, Oniguruma) build for Linux x86-64, x86-32 and Windows x86.
