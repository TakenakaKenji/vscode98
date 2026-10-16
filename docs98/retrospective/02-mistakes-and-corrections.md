# 2 — Mistakes, misses and corrections

Every error that cost real time, grouped by kind. Format: **what happened** → wrong turns (if any) → **root cause** → fix → *rule*. The rules are collected in [05-working-practices.md](05-working-practices.md).

## A. Measuring the wrong thing, or not measuring

**A1. Optimising without an external baseline (spikes 8 to 11, packages v1 to v12).** Each round compared against the previous round of our own host. The internal numbers improved while the product stayed 3 to 23 times slower than stock VS Code on the same laptop, and v12 got *worse* (the owner: "unusable"). Only after the owner insisted ("we should be trending upward, not downward") was the control benchmark built (spike 12). It immediately showed where the time went (style 65 to 87 %) and turned the work into a measurable ratio. → *Build the control benchmark with the first runnable build; re-run it every round.*

**A2. Naming the bottleneck before profiling (spike 6 → 7).** Spike 6 concluded that layout and the rasterizer were the problem and spike 7 ported both to C. Spike 7's own profile then showed style (selector matching) was 90 % of the time: 6.1 s of 7.3 s. The C layout and rasterizer were still worth having, but the main cost stayed in place for six more spikes. → *Split timings before naming a bottleneck.*

**A3. "The VM is slow" (round 2).** UI ready took ~127 s on the VM vs ~12 s natively and ~40 s under Wine, which was blamed on the VM. A micro-benchmark (`bench.js`: VM 7.2 s, native Linux 9.1 s, Wine 16.5 s) disproved it and pointed at two Windows-only host bugs: quadratic file reads and the 15.6 ms timer tick. → *Separate machine speed from host bugs with a small fixed benchmark before blaming the machine.*

**A4. Compiler flags as a lever (round 2).** SSE2, i686 and -O3 builds were tried; all were within noise of the i586 baseline. → *Measure the algorithmic cost first; flags rarely matter for an interpreter.*

**A5. Benchmarks on a shared CPU.** Style profiles taken while the 11-scenario suite ran in the background disagreed by ±20 %, and an earlier control run was skewed by a leftover Electron instance. → *Pin CPUs; nothing else running; median of 5.*

**A6. Comparing absolute pass counts across builds (spike 9).** A faster boot changed timer interleaving, so the number of layout passes went *up* (131 → 163) while time went down. → *Compare per-pass costs and per-action latencies, not pass counts.*

## B. Wrong hypotheses while debugging

**B1. The Windows new-file stall (round 10, ~half a day).** New files appeared after 15 to 20 s, or only after clicking around. Wrong turns, each "fixed" and committed: handle overflow (>63 wait handles; real, but not this), stderr flooding by transient unhandled rejections (real, kept), stream backpressure in fd readers (changed, then reverted), message handlers throwing (real, kept). **Root cause:** in `winproc.c`, a write queued behind an in-flight overlapped write was only flushed when the *next* write came, because the completion was waited on only while JavaScript had a write handler set. Found by tracing request ids at both ends of the IPC (`--debug-ipc 1`, `VSCODE98_TRACE_IPC`). → *Trace the message end to end first; then form one hypothesis with the observation that would refute it.*

**B2. The Linux host's random "main process exited: code 0" (days; root-caused 10-16).** Treated as a flake and retried (`runctl.sh` retries, `pkill -9`, sleeps). When it became frequent, more wrong turns: the SQLite shared-storage file written by the Electron control run (it caused other errors, but not the exit), an empty event loop (a keep-alive timer did not stop the exits), exceptions in timers (a real bug, fixed, but not the cause), stream backpressure stopping the IPC reader (tracing showed it never stopped). **Root cause:** QuickJS-ng's `js_os_poll` returns -1 when `poll()` is interrupted by a signal (`EINTR`), and `js_std_loop` then ends normally (exit 0). `child_process.js` listens for `SIGCHLD`, so any child exiting during `poll()` could end the main process; with 2 CPUs about one run in two. Found with `strace -f --seccomp-bpf -k -e trace=exit_group` (the C stack showed `main()` returning) and a debug build of `quickjs-libc.c` that printed why the loop ended ("poll returned -1; pending exception: 0; rw handlers empty: 0"). Fix: the Linux build compiles a patched `quickjs-libc.c` (`build.sh`). → *Never retry around a flake; get a stack of the exit and instrument the loop.*

**B3. A fuzz "bug" that was the test's fault (spike 13).** The native-matcher fuzz reported `:focus-within` differences. The matcher was right: the fuzz harness reset documents with `body.__children.length = 0`, bypassing `removeChild`, so the previous seed's focused element kept `parentNode` links to `body` while no longer in the tree. → *When an oracle disagrees, check which side is wrong and whether the test bypasses the API it tests.*

**B4. Shared state from the control run.** After the Electron 1.142 runs, our host inherited a real SQLite `~/.vscode-oss-shared/sharedStorage/state.vscdb` (same product data folder) and a still-running `code-oss`. Both were suspected; neither was the exit cause, but both had to be cleaned to get clean runs. → *Isolate control runs (separate HOME or data folder) and clean up after them.*

## C. Packaging misses (things the tree had and the package did not)

- **Fonts** (first desktop run): the font table named Linux `/usr/share/fonts` paths; under Wine those resolved to the host's fonts, so the real Windows 7 run showed a blank window. → bundled fonts, `--font-dir`; re-test under Wine with the host fonts hidden.
- **`vscode-textmate`, `iconv-lite-umd`, `jschardet`** missing from `needmods.txt` (v12): no syntax highlighting on Windows although native Oniguruma was in the exe. The grammar loader failed silently.
- **`@vscode/ripgrep-universal`** is what the bundles import, not `@vscode/ripgrep`; **git-base** is needed for git to activate.
- **Over-inclusion** (v12): all 86 built-in extensions shipped at once, which meant 10 processes and 1.1 GB on a 2 GB machine (part of "unusable"). Fixed by running the extension host tree at low priority.
→ *Boot and exercise the unpacked package (under Wine) before every send; keep the module list in one file; watch process count and memory of the package.*

## D. Wine hid real-Windows problems

Wine passed everything in spike 11, yet the real Windows 7 runs found: Linux font paths (resolved by Wine), raw Win32 `EEXIST` from `mkdir`, a realloc-per-8 KB file reader that is quadratic on the Windows heap (1775 ms for 15 MB), the 15.6 ms timer tick, an empty keymap breaking Ctrl shortcuts only on win32, and an idle repaint loop through `WM_PAINT`. → *Wine is a smoke test; get the real target into the loop as soon as anything boots, with status lines and screenshots in the log.*

## E. Missing browser or Node semantics (silent failures)

The pattern: the app catches an exception or gets `undefined`, and a feature simply does nothing.
- `Node.prototype` without `ELEMENT_NODE`/`TEXT_NODE` constants → Monaco's hit test threw inside a swallowed `try`; typing went to `body` (round 1).
- `crypto` missing → workspace id `undefined` → folders silently did not open (spike 10).
- QuickJS `error.stack` lacks the "Name: message" header → every logged error lost its message (spike 10).
- `EventEmitter` `on`/`off` not aliases of `addListener`/`removeListener` → infinite recursion and a segfault in readable-stream and sqlite3 (spike 10); an ES-class EventEmitter broke `EventEmitter.call(this)` (spike 5).
- The sqlite3 stand-in's classes did not extend EventEmitter. `sqlite3.js` copies `EventEmitter.prototype` with `for...in`, which sees no class methods, so `Statement#on` was missing and **every storage transaction threw** (found 10-16; it had been broken since spike 10).
- An exception in a timer, interval, `queueMicrotask` or `nextTick` ended QuickJS's event loop instead of reaching `uncaughtException` (found 10-16).
- QuickJS exits on any unhandled rejection (spike 8) → a tracker; later it reported thousands of transient ones that flooded stderr (round 10) → report only if still unhandled a macrotask later.
- `zoom` computed as "" (factor 0) → menus at 0,0 (round 5); `Intl` absent → the TypeScript compiler died after 40 s (spike 2); `TextDecoder('utf-16le')` absent → Monaco rendered nothing (spike 6).
- Process lifetime (reported in rounds 10 and 11, fixed in v17): Windows does not end a process's children with it, and Electron's "utility processes die with main" was never reproduced, so closing the window left 4 of 7 processes running. A job object with kill-on-close fixes it at the OS level; the JS-level fix (exit on IPC `disconnect`) first did nothing in the extension host because VS Code replaces `process.exit` there, which only a trace (`UTIL_TRACE`: "main disconnected" with no exit after it) showed.
- The top-level-await stall of the stock `qjs` loop hit three times (spikes 2, 5, 8) before it was written down as a rule.
→ *Lenient stubs find the API surface, but things that go through interop helpers need real objects; match the reference runtime's error semantics; when a feature "does nothing", look for a swallowed exception first.*

## F. Engine bugs that only real use found

- Stacking contexts in tree order instead of z-index order: a popup could end up under a modal; it only surfaced when boot timing changed (round 9).
- SVG rasterized at 2048² floats: 9.3 s for one icon (round 9). Every decoder needs a size cap.
- Caret placed at the end of the line: scroll compensation used an inline box's (0,0) position (round 10).
- Fixed-position boxes inheriting ancestor clips; top-layer paint and hit order (round 5).
- Per-frame `calloc` of full-size opacity layers (round 3); O(n) hit testing with temporary arrays (round 4).
- 15 soundness bugs in incremental style (14 found by the fuzzer, spike 9).
- Custom properties: every element that declared one copied the ~1500 workbench variables; 95 ms of a 300 ms restyle (found by profiling 10-16).
→ *Real-app scenarios and a fuzzer find what unit pages do not; cap every resource-proportional allocation.*

## G. Process and tool slips

- `pkill -f <pattern>` matched the running shell itself (exit 144) → use `pkill -x name`.
- A `--seconds 120` harness limit cut long scenarios and looked like a crash → `--seconds 900`.
- Synthetic events do not reproduce the menu-bar "move to Edit" action, and a File menu left open under the explorer made the next scripted click land on **Exit** (scenario_ctl) → Escape until no menu is open.
- Playwright could not drive Chromium 100 (VS Code 1.70.2) → raw CDP driver; `keyboard.type('.')` sent the key code of Delete → `Input.insertText`; Electron rejected symlinked `node_modules` → copies; 1.70.2 uses native menus on Linux → `titleBarStyle: custom`.
- A container restart killed background tasks mid-profile; work was safe only because it had just been committed.
- Stale test-profile state (Backups, `code.lock`, orphaned processes) caused false scenario failures → `runsc.sh` cleans it. Likewise a scenario that relied on an earlier one leaving `hello.txt` modified failed once the workspace was reset (2026-10-16; caught because it failed identically with the previous engine, `--style match`) → each check sets up its own precondition.
- A screenshot taken right after "stable" in verify mode (slower boot) showed the default theme before the real one was applied, which looked like a regression; an A/B of the two engines at the same moment was pixel-identical. → *Compare screenshots only between runs in the same mode, captured the same way.*
- Profiling instrumentation was once added to the repo files and had to be stripped before committing → profile on a copy (`/tmp/claude-0/mkprof.py`).
- Documentation drift: decisions D-003 to D-006 stayed "proposed", the roadmap's phase table, the targets feasibility table and the performance row of FEATURES.md were not updated after the spikes answered them (all corrected 2026-10-16). → *Update the decision log, roadmap and feature table in the same commit as the spike README.*

## H. Scope and direction

- **AI/agent UI was half the boot** (round 2: 322 → 66 layout passes once switched off). It had been measured as "the workbench" for several spikes. → *Cut out-of-scope features first and measure without them.*
- **XP-first vs feature-complete first** (round 6): the owner redirected to "every feature has to work on Windows 7 first"; the audit with scenarios followed and became the regression suite.
- **The planned architecture was more work than needed** ([02-architecture.md](../02-architecture.md) planned a native launcher replacing electron-main; spike 10 showed the real electron-main runs unmodified on a small stub). → *Before writing a replacement, try running the original against a stub of its platform API.*
