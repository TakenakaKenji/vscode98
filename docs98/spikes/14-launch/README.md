# Spike 14 — Launch timeline, bytecode cache and sampling profiler

**Question:** round 12 showed that v18 removed 2.6 s of the window process's CPU at startup and the laptop's launch did not change. Where does the launch actually go, process by process, and what is on its critical path?

**Status (2026-10-17):** package v20 ships the cache (prebuilt under Wine, module paths rewritten on load), so the first start after unzipping no longer compiles. Earlier, **2026-10-16:** the timeline is built into every process and printed by the desktop harness (`--timeline <dir>`, on in `run-desktop.cmd` from package v19). Its first run answered the question: **compiling the 42.7 MB workbench bundle** (`workbench.desktop.main.js`) is the largest single piece of the launch, with the window process at 100 % CPU and the other processes idle. A bytecode cache for large ES modules removes most of it from the second start on: the workbench is started 5.9 s sooner on the sandbox and 8.3 s sooner under Wine. Package v19 carries both (SHA256 `3b73fd1a434fa0c50ff4d7dca602482756d345fe8e1bfc61f2e023cd43b481cd`, joined zip; the 11 feature scenarios pass with the cache on; no processes left after closing); laptop (round 13): launch 20 s on the first start, **12 s on the second**.

## The timeline

- **Per process, in C** (`07-native-render/host/timeline98.h`, included by the patched `quickjs-libc.c` of both hosts): wall time in 100 ms buckets; the event loop's waits (`poll`, `WaitForMultipleObjects`/`MsgWaitForMultipleObjects`, `Sleep`) and the blocking waits of synchronous calls (`spawnSync`, from `proc.c`/`winproc.c`) are added to the buckets, and the rest is time spent running JavaScript. No JavaScript timers (a timer could keep a process alive). On when `QJS98_TIMELINE` names a directory (inherited by every child) or after `__timelineStart(dir)`; every ~2 s, at a point where the loop is about to wait, the process writes `<dir>/<pid>.json` with its buckets and whatever `__timelineInfo()` returns.
- **Labels and marks** (`05-child-process/host/proc_setup.mjs`, `run_main.mjs`, `util_child_main.mjs`): each process names itself (`window`, `main`, the utility process's service name, else the script name) and reports VS Code's own performance marks (`globalThis.MonacoPerformanceMarks`, epoch milliseconds, so they line up across processes).
- **Merged by the harness** (`10-main-shim/host/timeline_report98.js`, `boot_desktop_qjs.mjs --timeline <dir>`) when the workbench is stable: a table with one row per second and one column per process (% of the second running JavaScript, `s` for blocked in a synchronous call), busy totals, the seconds in which the window mostly waited and what else was busy then, and the phase marks (`code/willX`/`code/didX`, lifecycle phases, the harness's own; the ~700 per-contribution and per-extension-point marks are only counted).

## What it showed

Desktop boot, sandbox (2.1 GHz, 2 CPUs), v18:

| Mark (window process) | s |
|---|---|
| `code/didStartRenderer` | 0.72 |
| `code/willLoadWorkbenchMain` | 0.72 |
| `code/didLoadWorkbenchMain` | 7.57 |
| `code/didStartWorkbench` | ~8.9 |
| `code/LifecyclePhase/Eventually` | ~11.4 |

From 1 to 10 s the window ran JavaScript 100 % of every second while main, the shared process and the extension host were idle or not started: **the window process is the critical path, and 6.85 s of it is loading the workbench bundle.** Measured alone (`std.evalScript(src, { compile_only: true, compile_module: true })`, one core): compiling it takes 4.4 to 4.9 s; the rest of the load is running its top-level code. `JS_WriteObject` of the compiled module is 98 MB (25.7 MB without the source text, 22.4 MB without line numbers too), and reading it back takes 0.26 s (0.19 s without the source).

This also explains round 12: the style pass that v18 shortened comes after this, and the window then waited for the other processes, which were still catching up.

## The bytecode cache

`05-child-process/host/esm.c` `compile_module`: an ES module of at least 128 KB that `__esmLoad` hands over as source is compiled through a cache. Key: FNV-1a 64 of the module name and the source (the name is part of the compiled module and resolves its relative imports, so the cache is per install path: it cannot be shipped in the package). File: `<dir>/<key>.qbc`, a header naming this build (`__DATE__ __TIME__`, so another executable never reads it), then `JS_WriteObject(…, JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_STRIP_SOURCE)`: line numbers stay (stack traces keep working); `Function.prototype.toString` of these functions shows no source. Anything wrong with the file means compiling as before. `import.meta` is set from the current load, as before. The directory is `QJS98_CODE_CACHE` or `__codeCacheDir(dir)`; the desktop harness uses `--code-cache <dir>` (default `<user-data-dir>/code-cache`, `0` = off) and passes it on to every process it starts. The first start writes 8 files (the workbench, main, shared process, extension host and smaller bundles); the write costs no measurable time.

| Desktop boot | cache off | first start (writes) | second start (reads) |
|---|---|---|---|
| Sandbox: `code/didLoadWorkbenchMain` | 6.93 s | 6.99 s | 1.09 s |
| Sandbox: `code/didStartWorkbench` | 8.85 s | 8.80 s | 2.91 s |
| Sandbox: `code/LifecyclePhase/Eventually` | 11.35 s | 11.66 s | 5.66 s |
| Sandbox: window process busy, whole boot | 16.0 s | 16.1 s | 10.1 s |
| Wine (Windows exe, suite running alongside): `code/didStartWorkbench` | | 13.49 s | 5.16 s |
| Wine: total until stable | | 23.0 s | 16.6 s |
| Wine, nothing else running (package v19 unpacked): `code/didStartWorkbench` | | 9.26 s | 4.79 s |
| Wine, nothing else running: total until stable | | 22.0 s | 16.4 s |

## The cache in the package (v20)

The laptop's round 13: the first start after unzipping still compiled (20 s), the second read the cache (12 s); the owner always tests a fresh unzip, and a user's first launch matters too. The cache was tied to the install folder because the module name is compiled into the bytecode. Now:

- **The key is the hash of the source only**, and the file records the name the module was compiled under. When the name differs, `bc_rename` (`esm.c`) rewrites that one string in the bytecode's atom table (QuickJS-ng `JS_WriteObjectAtoms` layout: version byte, checksum, leb128 count, per atom a type byte and `JS_WriteString`: leb128(len << 1 | wide) and 8-bit or UTF-16 units); every other use refers to the atom by index. The checksum is set to QuickJS's "not checked" value (`0xFFFFFFFF`); a malformed buffer still fails in `JS_ReadObject` and falls back to compiling.
- **`package_desktop.sh` prebuilds it**: when Wine is installed it boots the package once, headless, with the executable that ships (the cache header names the build), and keeps only `userdata/code-cache` (8 files, 32 MB; the zip grows from ~80 to 92.8 MB). `PREBUILD_CACHE=0` skips this.

Checks: the 11 feature scenarios run from a hard-linked copy of the app at another path with a cache built from the original path (every large module renamed on load): all pass. Wine, v20 unpacked to another folder than the one the cache was built in, nothing else running: `code/didStartWorkbench` 3.94 s on the first start and 3.94 s on the second (v19 the same day on that machine: first start compiled, ~9 s); the window renders as before; no processes left after closing.

## What is left (warm cache, Wine)

- 0.7 → 2.0 s: the window process prepares the page before the workbench code starts (`willWaitForWindowConfig` → `didWaitForWindowConfig`: the harness's own work, fonts and stylesheets among it).
- 2.0 → 3.9 s: loading the bundle from bytecode plus running its top-level code.
- 3.9 → ~11 s: the workbench's startup at nearly 100 % of the window process; main and the shared process work alongside and are not waited for.
- CommonJS modules (most built-in extensions) are not cached yet (`Module` shim, not `esm.c`).

## The sampling profiler (v22)

The timeline says which process is busy; the profiler says on what. `07-native-render/host/prof98.h` is compiled into QuickJS itself (`patch_quickjs.py` appends it to a copy of `quickjs.c` in both builds, so it reads QuickJS's own call frames). It is off unless `QJS98_PROFILE` is the interval in ms (`run-desktop.cmd` sets 2; children inherit it).

- Sampling copies the frame chain of the main runtime (`rt->current_stack_frame`): per frame the function's bytecode, or the C function and its magic. Nothing is allocated, locked or run while sampling. Windows: a sampler thread suspends the main thread (`SuspendThread` + `GetThreadContext`), copies, resumes; wall time, so the loop's wait is `[idle]`. Linux: a CPU-time timer of the main thread (`timer_create(CLOCK_THREAD_CPUTIME_ID)`, `SIGPROF` to that thread).
- Each sample carries the time it stands for (the Linux CPU timer fires on the 4 ms kernel tick whatever interval is asked for: with a fixed weight every count came out at half).
- Names are made on the main thread: each loop turn, when the ring of raw samples is half full (`js_poll_interrupts`), and just before a function's bytecode is freed (so a sampled pointer is named while valid and a reused address gets a new id). C functions are named where they are created; methods and `const f = () => ...` get the names QuickJS gives them at run time (their bytecode has none). Labels for work without a frame: `[gc]`, `[compile]`, `[read bytecode]`, `[idle]`, `[host]` (C code outside any JavaScript call).
- QuickJS links a C function's frame into the chain before setting `cur_func`; the patch links it after, behind a compiler barrier, so a sample never reads a half-built frame.
- Output: `<timeline dir>/<pid>.prof.json` (names, interned stacks, samples as time / stack / weight; repeated samples merged within 100 ms). `10-main-shim/host/profile_report98.js` prints after the timeline, per process: time by source file, top functions by self and inclusive time, and for the window the top 3 per second of the launch; `results\profile.txt` has the longer tables, the call paths of the top 25 and every process.

Oracle: `14-launch/tests/prof_oracle.mjs` burns known amounts of CPU in plain functions, a native call (`JSON.parse`), a closure called through `Array.prototype.map`, a recursion deeper than the 64 recorded frames, short-lived functions (their bytecode freed while sampling), a method, a getter, an arrow function and `std.gc()`; every row within 15 % (in practice within 1 to 3 %) on Linux and under Wine at 2 and 5 ms. Overhead (CPU benchmark `bench.js`, 1 CPU, medians of 5): old build 7600 ms, new build with the profiler off 7232 ms, on at 2 ms 7402 ms. The 11 feature scenarios pass with it on; under Wine the package boots and closes with no process left.

First profile, sandbox (Linux, 2 CPUs, warm cache, CPU time; the window process 10.2 s busy until stable):

| | window | main | shared process |
|---|---|---|---|
| base64 of IPC binary data (`codec98.js` `toBase64`/`fromBase64`) | 0.9 s (9 %) | 2.0 s (62 %) | 0.8 s (33 %) |
| harness stability check: `getElementsByTagName('*')` every 20 ms (`boot_common.js runScenario`) | 0.8 s (8 %) | | |
| VS Code's font measurement (`readCharWidths`, one forced layout per `offsetWidth`), inclusive | 1.2 s (12 %) | | |
| style passes (`resolveStyles`), inclusive | 2.6 s (25 %) | | |

The laptop's profile (v22) decides the order of the work.

## The laptop's v22 profile and what v23 changed

Owner, v22, two starts: about 10 s until the window shows the workbench and 22 s until it is stable, both times. The second start restored a JavaScript file opened in the first (`t.js`), so the extension host loaded the TypeScript extension during the launch. The window process was busy almost every second from 1 s to 22 s, so its busy time is the launch. What the profile showed (second start; busy time is wall time):

| | window (21.4 s busy) | main (2.2 s) | shared process (8.1 s) | extension host (8.9 s) |
|---|---|---|---|---|
| base64 of IPC data (`codec98.js`) | 2.3 s | 1.1 s | 2.9 s | 0.2 s |
| IPC line splitting (`indexOf` from the start of the buffer on every chunk) | 0.33 s | | | |
| VS Code's `Module._nodeModulePaths` filter (`path.relative` per ancestor, per module) | | | | 3.5 s |
| `Module.isBuiltin` (regex + `Array.includes`, on every `require`) | | | | 0.6 s |

v23:
- **Base64 in C** (`05-child-process/host/b64_98.h`, globals `__base64Encode` / `__base64Decode` in both hosts, used by `codec98.js` when present). Oracle `10-main-shim/tests/b64_oracle.mjs`: the same bytes and strings as the JS loops for every length 0 to 2000, offset views, ArrayBuffers, padded, odd-length and non-ASCII strings; 4 MB in 13 to 33 ms instead of 0.8 to 1.5 s (Linux and Wine).
- **IPC framing scans each chunk once** (`lineSplitter` in `05-child-process/host/impl/fdstreams.js`, both ends: `child_process.js` and `proc_setup.mjs`).
- **The CommonJS loader caches like Node** (`02-node-shim/host/impl/module.js`): `module.paths` once per directory (until someone replaces `Module._nodeModulePaths` again), the nearest `package.json` type once per directory, `parent.path + request` → filename for modules already loaded (Node's `relativeResolveCache`), `isBuiltin` as a Set lookup.
- **The report says how far each process's samples go**: a process writes its file when its event loop is about to wait, at most every 2 s, so one that is busy for a long stretch (the extension host loading an extension) has newer samples than the file at the moment of the report. Each process line now ends with the span of its samples and says when the file is more than 1.5 s old. On Windows "busy" is wall time and includes waiting for a CPU while other processes run (the header says so).

Wine, second start with a restored JavaScript file (`10-main-shim/host/scenario_openfile.mjs` opens it in the first start), profiler off, two runs each:

| | v22 | v23 |
|---|---|---|
| until stable | 22.6, 21.5 s | 18.9, 17.5 s |
| window busy | 16.0, 15.4 s | 12.8, 11.9 s |
| main busy | 7.2, 6.5 s | 2.5, 2.9 s |
| shared process busy | 5.1, 5.1 s | 2.7, 2.8 s |

With v23 neither `codec98.js` nor `path.relative` appears in any process's top list. The 11 feature scenarios pass.

### The profiler under Wine

Wine implements `SuspendThread` with a signal. A signal that lands while the thread writes a request to the wineserver cuts the write short, and Wine then ends the thread ("wine client error: partial write 65536"). A pipe write carries its data in such a request. In 3 of 3 profiled Wine starts that opened or restored a JavaScript file, the main process died this way. It never happened without the profiler, and it cannot happen on Windows, where suspension is done by the kernel. The fix (`prof98.h`, `winproc.c`):
- Around pipe writes (`js98_pf_io_enter` / `leave`), the main thread copies its own frame chain, which cannot change inside a C call, and the sampler stamps that copy instead of suspending the thread.
- A sequence number tells the sampler whether the copy is current.
- The sampler announces a suspension before it checks, and a thread entering a write waits until no suspension is announced. That closes the gap between the check and `SuspendThread`: the first version without it still lost main in 2 of 2 starts.

After the fix: 4 of 4 profiled starts with no failure. The profiler oracle passes on Linux and Wine. Under Wine the profiler at 2 ms costs about 25 % (23 to 24 s until stable instead of 17.5 to 19 s), because each suspension is a round trip through the wineserver. Compare Wine timings with the profiler off (`QJS98_PROFILE` unset).

## The laptop's v23 profile and what v24 changed

Owner, v23: 8 s until the workbench shows in both starts; until stable 19 s (first start) and 15 s (second). In the second start the window process was busy almost every second from 1 to 15 s, so its busy time is still the launch. Its largest items (inclusive, 16.1 s busy): the style rule index of the first passes (`buildRuleIndex` 1.6 s, `analyzeIndex` 1.2 s), font parsing (opentype.js `parseBuffer` 1.0 s), SVG decoding (0.9 s), VS Code's font measurement (`readCharWidths` 0.5 s). Base64 and the extension host's module paths no longer appear.

v24:
- **Fonts are parsed lazily** (`opentype.parse(buf, { lowMemory: true })` in `06-rendering/host/dom/fonts.js` and for `@font-face` in `env.js`): glyphs are read when first used, not all at load. Oracle `06-rendering/tests/font_lazy_oracle.mjs`: the 12 shipped fonts and `codicon.ttf` give the same metrics, glyph indices, advance widths, outlines and kerning for 31,941 code points; the parse takes 0.49 s instead of 2.05 s (Linux), 0.44 s instead of 2.03 s (Wine).
- **The SVG rasterizer's scanline loops are in C** (`07-native-render/host/svg98.h`, globals `__svgFill` / `__svgToRGBA8`, used by `06-rendering/host/dom/svg.js`). The arithmetic matches the JS step by step: doubles, a float32 accumulator and image, and a stable sort of the crossings. Oracle `06-rendering/tests/svg_native_oracle.mjs`: every SVG of the app at scale 1 and 2, with and without a currentColor, gives the same bytes (156 decodes on Linux, 114 under Wine). `code-icon.svg` (the watermark logo, 559 bytes, 256×256) takes 7 ms instead of 216 ms.
- **The invalidation analysis builds a compound's shape only when it is used** (`style_invalidation.js` `scanComplex`: shapes are only needed for state keys in context and for compounds with pseudo-classes). Oracle `09-incremental-style/tests/analyze_oracle.mjs`: the analysis of the workbench's 14,097 rule entries is the same as JSON; 92.6 → 64.5 ms in V8. Style fuzz: 7,500 passes, 0 mismatches.

Wine, plain starts, profiler off: second and third starts 19.6 and 18.8 s until stable with v23, 17.7 and 16.9 s with v24 (window busy 13.7/13.2 → 12.0/11.3 s, `didStartWorkbench` 7.2/7.0 → 5.9/5.3 s). First start 21.6 → 21.1 s: under Wine it is dominated by file and pipe I/O (`loadFile` 1.7 s, pipe writes 1.7 s, reading bytecode 1.3 s in a profiled start), which were much smaller on the laptop.

Not done yet: `buildRuleIndex` runs on each of the 12 to 14 rule-set changes of the launch and flattens and compares all ~14,000 rules each time. A per-sheet cache needs a change counter on stylesheets that also covers edits of single rules.

## The laptop's v24 profile and what v25 changed

Owner, v24: 8 s until the workbench shows; until stable 14 s in the second start (v23: 15 s, v22: 22 s). The window was busy until 14.8 s (13.9 s busy). Its style engine time: rule index 2.44 s (1.77 s of it in the first pass, which styles the 6-element splash), planning 0.66 s, restyling 1.16 s, of which `varsEqual` (custom-property scopes, in C) was 0.52 s.

v25:
- **`varsEqual` without the whole chain** (`07-native-render/host/style_compute.c` `scope_equal`). Two scopes whose own properties differed were compared over their whole chains (~1,000 `--vscode-*` variables), and only "equal" answers were remembered. When a scope near the root changed, every descendant's comparison repeated that work. In a Linux boot, 2,116 calls from JavaScript became 5,878 whole-chain comparisons that collected 26.6 million entries. Now: with equal parents (or two flattened scopes), only the names the two scopes define themselves are compared, and the latest unequal pair is remembered too. That boot: 381 whole-chain comparisons, 2.0 million entries, restyling 1,629 → 812 ms. The answers stay exact, because the harness's style verify mode compares with `varsEqual`. `QJS98_VARS_VERIFY=1` computes every answer the old way as well and counts differences: 0 in a boot, and 0 in 89,968 comparisons of the style fuzz on the native engine (`FUZZ_NATIVE=1`; the fuzz now prints these counts).
- **The first full analysis of the rules is saved** (`style_invalidation.js` `setAnalysisStore`; the harness keeps `style-<key>.json` next to the bytecode in `userdata/code-cache`). The key is a hash (new native `__fnv1a64`) of every entry's selector in scan order and of `ANALYSIS_FORMAT`. Later starts read the analysis instead of computing it (~40 % of the first pass). Oracle: `09-incremental-style/tests/analyze_oracle.mjs` analyses the workbench's rules, saves the analysis to an in-memory store, reads it back, and checks the restored analysis equals the computed one (and the v23 baseline). Linux boots: first pass 983 ms (saving) → 647 and 592 ms (reading). The package's prebuild boot runs headless, and its first pass sees more rules than a windowed start (14,565 entries against 14,200), so the first windowed start writes its own file and the later ones read it.

Wine, plain starts, profiler off (v24 → v25): 21.8 → 19.6 s until stable (first start), 17.4 → 16.7 s and 15.9 → 15.4 s (later starts); window busy 14.7 → 12.7, 11.7 → 11.1, 10.3 → 9.9 s; restyling 1,100/857/708 → 459/383/373 ms. The 11 feature scenarios pass; no process left after Alt+F4.

## Interaction speed (v26)

The owner asked to switch from launch to interactions, after the laptop control (stock VS Code 1.70.2 4 s / 8 s, v25 7 s / 15 to 16 s) and the sandbox control benchmark (clicks and menus 3 to 12 times slower than stock). Method: `scenario_ctl.mjs --marks 1` marks every action in the profile and `14-launch/tests/profile_actions.mjs` prints self and inclusive time per action.

**Where an interaction goes (v25, sandbox):** the layout pipeline is 65 % (`resolveStyles` with `computeNative` about 9 % and `planRestyle` helpers about 5 %, `build` and the `Box` constructor about 13 %, the `packTree` walk about 9 % and its allocations, `countElements` about 3 %, paint about 10 %), plus a tail of garbage collections. The profiler caps a sample at 100 ms, so it understates the collections; timing `__gcNow` directly shows **one collection takes 0.75 to 1 s** (heap about 340 MB, about 1 M objects in the renderer), and QuickJS runs it inside whatever allocation crosses the threshold, i.e. inside a click or a menu.

**What v26 changed (all with oracles or A/B runs):**
- **One shared `Pack`** for `packTree` (`layout_pack.js` `reset()`): the 80-field records were reallocated each pass. The unused `pk.index` map is gone. Same typed arrays, same layout.
- **Box-tree disposal** (`dom/layout.js` `disposeLayout`, called from `env.js __ensureLayout`, one pass late because the previous layout can still be read during the pass). Every full pass builds a new `Layout` and a tree of about 1,500 boxes whose parent/children, box/`__rects` and frag/box cycles only the cycle collector can free. Disposal cuts them. Garbage from boxes dropped about 4 times. `__noDispose98` turns it off for A/B runs (`scenario_ctl.mjs --no-dispose 1`).
- **Collection at idle moments** (`07-native-render/host/gc98.h`, hooked into `js_trigger_gc` by `patch_quickjs.py`). Soft threshold: stock 1.5 x the heap after a collection; the host collects when it is reached, at an idle moment (nothing dirty, 800 ms since the last paint or input, `window_host98.mjs tick`). Hard threshold: `QJS98_GC_HARD`, default +150 % (2.5 x), the only one that still forces a collection inside an allocation. Only the window process opts in (`__gcIdle(true)`); `QJS98_GC=0` is the stock behaviour. New globals `__gcIdle/__gcWanted/__gcNow/__gcStats`; the harness prints `garbage collector (...)` at the end of `desktop.txt` (runs, ms, forced).
- **Census** (`gc98_census`, mode 1 garbage with referrer tally, mode 2 live objects): what is left is VS Code's own cyclic closures and arrays (about 85 K arrays and 65 K closures per collection), not ours.

**Results.** Linux, `scenario_ctl` against v25, 20 rounds: sum of the means of the 12 actions -10 %, worst single actions much lower because no collection lands inside them. Windows build under Wine (same 20 rounds): same direction. Single Wine runs of the control scenario vary more than that (`context` 372 to 454 ms between two runs of one build), so the A/B means over many rounds are the evidence, not one table. The idle collection itself was exercised through `scenario_ctl` only: in a real window with xdotool the heap stayed under the soft limit (186 of 203 MB), so no idle collection ran there.

**Open: memory growth of the window process during use.** Driving the File and Edit menus 25 x 2 under Wine: RSS 266 to 405 to 409 MB (v25) and 251 to 386 MB (v26) between 15 s and 120 s, layout passes 48 to about 440, JS heap constant at 186 MB. So it is outside the JS heap, present in v25 as well, and similar to the laptop's v22 growth (349 to 880 MB total). Candidates: a native buffer per layout pass (`layout.c`), the allocator under Wine. To be measured with a pass counter against `mallinfo` / `GetProcessMemoryInfo` before any change.

**Still per pass, not yet done:** `computeNative` wrapper, `build` and `Box`, the `packTree` walk, `countElements`, `planRestyle`, paint. The structural win is an incremental layout (only the changed subtrees), not another constant factor.

**What to look for on the laptop (v26):** `QJS98_PROFILE=0` in `run-desktop.cmd` (line 21) for the feel of menus and clicks; the `garbage collector (...)` line at the end of `desktop.txt` (runs and total ms, forced collections should be few after boot).

## How the Wine runs compare with the laptop

The same metrics from the harness log of each start. The laptop runs are with the profiler on (`run-desktop.cmd`); the Wine runs without it, because under Wine the profiler costs about 25 %. Laptop: second start. Wine: later starts of a fresh copy (n2, n3). "Full paint" is the first paint of about 400 elements (the workbench visible). "Busy" is the window process's busy time.

| | laptop: full paint / didStartWorkbench / last paint / busy | Wine: same | laptop ÷ Wine |
|---|---|---|---|
| v23 | 8.7 / 7.6 / 20.7 / 16.1 s | 7.8 / 7.1 / 13.3 / 13.5 s | 1.11 / 1.07 / — / 1.20 |
| v24 | 7.0 / 6.7 / 14.8 / 13.9 s | 5.4 / 5.3 / 11.1 / 11.0 s | 1.30 / 1.27 / 1.34 / 1.26 |
| v25 | (not yet) | 5.3 / 5.2 / 10.7 / 10.5 s | |

- The laptop is 7 to 34 % slower than these Wine runs. Some of that is the profiler, whose cost on real Windows is not measured; one laptop start with the profiler off would tell.
- The direction of each change agreed between the two. Wine overstated the v23 → v24 gain: `didStartWorkbench` −26 % under Wine, −12 % on the laptop.
- With the v24 ratios, v25 should come out at about 6.6 s to `didStartWorkbench` and about 13 s busy on the laptop.
- The harness's "until stable" waits for a quiet period after the last paint. On the laptop it is 4 to 5 s later than what the owner reports (v24: 19.8 s logged, 14 s seen; last paint 14.8 s). The last paint is the closer match.

## Files

- `07-native-render/host/timeline98.h`; hooks in `07-native-render/host/build.sh` (Linux `quickjs-libc.c` patch), `11-windows-host/host/patch_libc.py`, `05-child-process/host/proc.c`, `11-windows-host/host/winproc.c`.
- `10-main-shim/host/timeline_report98.js`, `boot_desktop_qjs.mjs` (`--timeline`, `--code-cache`), `11-windows-host/package/run-desktop.cmd` (timeline on; keeps the previous log as `results\desktop-prev.txt`).
- `05-child-process/host/esm.c` (the cache).
- `06-rendering/tests/font_lazy_oracle.mjs`, `07-native-render/host/svg98.h` (SVG scanlines in C), `06-rendering/tests/svg_native_oracle.mjs`, `09-incremental-style/tests/analyze_oracle.mjs`.
- `05-child-process/host/b64_98.h` (base64 in C), `10-main-shim/tests/b64_oracle.mjs`, `10-main-shim/host/scenario_openfile.mjs` (opens a file so that the next start restores it).
- `07-native-render/host/prof98.h`, `07-native-render/host/patch_quickjs.py` (the profiler; the `[idle]` label and the file writes from `timeline98.h`), `10-main-shim/host/profile_report98.js`, `14-launch/tests/prof_oracle.mjs`.
- `07-native-render/host/gc98.h` (idle collection schedule, census), `14-launch/tests/profile_actions.mjs` (per-action profile), `06-rendering/host/dom/layout.js` `disposeLayout`.
