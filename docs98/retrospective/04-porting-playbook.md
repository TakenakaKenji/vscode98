# 4 — Playbook: moving an Electron app off Electron

A rough guide distilled from vscode98, written for the next app. It assumes the goal is "the same app, unmodified or nearly so, without Electron", on a platform Electron no longer supports (old Windows) or where Electron is too heavy. Numbers are from vscode98 unless said otherwise. Where vscode98 went the long way round, the shorter way is given and marked **(we learned this late)**.

## 0. Decide whether to do it at all

- An Electron app is three things: **Chromium** (the UI engine), **Node** (the backend runtime) and **Electron's main-process API** (windows, menus, dialogs, IPC). Replacing all three is a large, open-ended project; replacing only one (e.g. an older Electron, or a different shell around the same Chromium) is far cheaper. Rule out the cheap options first: the last Electron that runs on the target, a fork that backports, or a remote/server mode with a thin client.
- Expect a **slower but lighter** result. vscode98 on QuickJS-ng runs JavaScript ~8.5 times slower than V8 with JIT (~2.2 times slower than V8 without JIT) and is, after 13 spikes, 2.4 to 8.6 times slower per interaction than stock Electron VS Code, with 20 to 25 % less memory. If the app must be as fast as on Electron, this route does not get there by porting alone.
- Write down the goal, the scope cuts (vscode98: no AI/agent/cloud features on old Windows) and the target floor (OS, CPU, RAM) before starting (`01-goal-and-scope.md`, `03-targets-and-limits.md`).

## 1. Inventory: measure what the app actually uses

Static scans over-approximate; **runtime traces are the truth**. In this order:
1. Static greps of the source for DOM/Web APIs, Node built-ins, Electron APIs, native modules, JS language level (`inventory/`).
2. Build the stock app and **trace it at runtime**: every DOM/Web member called during startup and scripted scenarios (vscode98: ~312 distinct members, 227 CSS properties), every Node function and Electron method per process (119 Node functions in ~13 modules, 102 Electron methods/events), every child process. Hook all processes, including children that strip `NODE_OPTIONS`.
3. Measure the production bundle: size, JS level (vscode98: 58 MB of ES2024 modules, not downlevelled), startup time and memory on a reference machine. This is the control for later.
4. List native addons; each needs a plan (rebuild, JavaScript stand-in, or drop).

Pitfalls: a hook that silently loses a whole API group (one exception lost every Electron module after `screen`); dev-mode builds inflating counts. Sanity-check suspiciously empty or round results.

## 2. Pick the JavaScript engine by compiling the real bundle

- Compile-only first: does the engine parse every file of the production bundle unmodified, how long, how much memory, which built-ins are missing? (QuickJS-ng: all 30 files; missing `Intl`, `WebAssembly`, `structuredClone`.)
- Then execute heavy real code (a language server, a tokenizer) against V8 for speed and identical results.
- Downlevelling the bundle (esbuild to ES2015) widens the engine choice but changes the code under test; vscode98 did not need it.

## 3. Build the Node-side half first

The backend processes (extension host, language servers, file watcher, shared process) are pure JavaScript on Node APIs and are the easiest to move. Order that worked:
1. A shim layer per Node built-in (`fs`, `path`, `os`, `events`, `stream`, `buffer`, `crypto` subsets), generated as modules from one source of truth.
2. The module loader: CommonJS `require` with Node's resolution, `require(esm)`, ES-module resolution hooks. Apps patch private `Module` internals (VS Code intercepts `require('vscode')`); support what they patch.
3. A small native layer for what JavaScript cannot do: `spawn` with an fd map, pipes, socketpairs, sockets, `poll`-driven readiness (vscode98 spike 5: 374 lines of C). `child_process.fork` **with an IPC channel** is a hard requirement for language servers.
4. Native addons: **JavaScript stand-ins** are often enough and far easier than rebuilding (SQLite key/value store as JSON, file watcher by polling, keymap, pty over pipes). Make stand-in classes behave like the real ones down to inheritance: `sqlite3.js` copies `EventEmitter.prototype` with `for...in`, so the stand-in classes must *extend* EventEmitter (we learned this late: every storage transaction had been failing).
5. **Match Node's error semantics, not just its APIs** (we learned this late): an exception in a timer, interval, microtask or `nextTick` goes to `uncaughtException` listeners in Node; a raw engine loop may simply stop. Unhandled rejections should be reported only if still unhandled a macrotask later. A signal interrupting `poll()` must not end the loop (`EINTR`).

## 4. Keep the app's own main process; stub Electron under it

**(we learned this in spike 10; the original architecture planned a native replacement.)** Do not reimplement the main process. Run the app's real electron-main bundle on the new runtime against an **`electron` stub module**: `app`, `BrowserWindow` (a record whose web contents live in your renderer), `ipcMain`, `MessageChannelMain`/ports, `utilityProcess` (fork), `shell`, `dialog`, `screen`, `nativeTheme`, menus, protocol handlers. Implement what the runtime trace shows and stub the rest leniently (return sensible defaults, log the call). vscode98's main runs unmodified this way, including its storage, file service, lifecycle and window state.
- IPC between renderer and main: one JSON-lines channel with a binary codec for buffers on every hop; message ports relayed by id.
- Add trace switches for the IPC from day one (both directions, timestamps). Several stalls were IPC delays that looked like slowness.

## 5. The UI: own DOM, CSS, layout and painter

This is the largest part. What worked:
- **Write the DOM/CSS/layout engine in JavaScript first**, against the trace's API list, and check it against Chromium: geometry of every element (`getBoundingClientRect` dumps compared to a headless Chromium run of the same page) and framebuffers. vscode98 ran the real Monaco editor and a static replay of the workbench this way before booting anything.
- **Then move hot parts to C behind the same interface, with byte-identical output** as the gate: layout (`layout.c`), rasterizer (`render.c`), selector matching (`style.c`). Keep the JavaScript implementation as the oracle and keep a verify mode that runs both.
- **Profile before porting** (we learned this late, twice): spike 6 assumed layout was the bottleneck; spike 7 measured that style resolution was. Spike 12 then showed style was 65 to 87 % of every slow interaction; the C matcher plus three JavaScript fixes in the computed-value step (layered custom properties, monotonic cascade, a cheap layout-change check) cut a full restyle from 585 to ~130 ms.
- **Incremental style invalidation is mandatory** for a real app: the workbench reads layout after almost every DOM change. A planner over the mutation log, cached matched rules, a rule-set delta, and an oracle that compares against a full restyle on every pass plus a randomised fuzz (spike 9: boot 175 s → 32 s, keystroke ~10 s → ~0.1 s, 0 mismatches in 650,000 fuzzed passes).
- Things a real app needs that are easy to forget: stacking contexts sorted by z-index (not tree order), top layer, `caretRangeFromPoint` with inline boxes, legacy WebKit APIs, the full legacy keyboard event model, pointer capture, HTML5 drag and drop, iframes as separate documents (webviews), `MessagePort`, image decoders, an SVG renderer **with a size cap** (one 2048² float raster took 9 s), bundled fonts (a system without them shows a blank window).
- WebAssembly: either embed an interpreter or replace the WASM package with a native binding that exports the same API. vscode98 replaced `vscode-oniguruma` with native libonig behind an AMD shim (no WebAssembly in the host).

## 6. The OS host

- Cross-compile from Linux (mingw-w64), one baseline binary for the CPU floor (vscode98: i586/x87, no SSE2/MMX/CMOV), check imports (`check_imports.sh`: only DLLs present on the oldest target) and ISA (`check_isa.sh`).
- A native process/pipe layer for the target (Windows: overlapped named pipes, `CreateProcess`, waitable process handles, named-pipe servers) behind the same JavaScript interface as on Linux. **Overlapped writes must be waited on even when nobody is writing next**, or queued data sits until the next write (the new-file stall of round 10).
- A window with a message pump inside the JavaScript event loop; `MsgWaitForMultipleObjects` takes at most 63 handles, so rotate when there are more.
- Run low-priority work at low OS priority (extension host and its children: `BELOW_NORMAL_PRIORITY_CLASS`).

## 7. Test on the real target early, with a package

- Wine is a smoke test. Real Windows 7 found what Wine did not: Linux font paths that Wine resolved (blank window on Windows), raw Win32 `EEXIST`, a realloc-per-chunk file reader that is quadratic on the Windows heap (1.8 s for 15 MB), the 15.6 ms timer tick (1000 chained zero timers = 15 s; `timeBeginPeriod(1)`), an idle repaint loop through `WM_PAINT`. Get a real machine (or the owner's) into the loop as soon as anything boots.
- **Ship a package and test the package.** Keep a list of the modules the app actually loads (`needmods.txt`) and boot the unpacked package before sending it; omissions (no TextMate module → no syntax highlighting) only show there.
- Scripted scenarios that drive the real UI with real DOM events and check DOM state (`scenario_*.mjs`), runnable headless and under Wine, with PASS/FAIL. vscode98 has 11 suites; run them after every engine change.

## 8. Keep a control benchmark from the start

**(we learned this late: spike 12 came after 11 spikes and 12 packages.)** Install the stock Electron app on the same machine and drive the same actions on both, from input event to visible result, same CPU limit, median of several rounds, with a time split for your side. Re-run after every performance round and report the ratio. Notes from building it:
- Playwright could not drive old Chromium (100); a raw DevTools-protocol driver could (`12-control/host/cdp_page.mjs`). Type text with `Input.insertText` ('.' as a key event became Delete).
- Electron enforces that app resources are real files inside its resource path (symlinked `node_modules` were rejected): copy.
- Old Electron on Linux uses native menus; set `window.titleBarStyle: custom` to compare HTML menus.
- Control runs leave state behind in shared folders (`~/.vscode-oss-shared`); isolate or clean it.

## 9. Order of work that would have been faster

1. Inventory with runtime traces; production baseline; **control benchmark harness** (so it exists from day one).
2. Engine compile + execute tests.
3. Node-side shims, loader, native process layer; backend processes and language servers running.
4. Main process on an `electron` stub.
5. JavaScript DOM/CSS/layout/paint engine checked against Chromium; real UI booted; incremental style with oracle.
6. **Profile** the real UI; move the measured hot parts to C with identical-output gates.
7. OS host + window; package; real-hardware rounds with fixed measurements; control benchmark every round.

Steps 3 to 5 can overlap; step 6 must not start before the profile of step 5 exists.
