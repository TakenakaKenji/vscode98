# Spike 11 — the host on Windows (x86, Windows 7 first)

**Question** ([CHECKPOINT](../../CHECKPOINT.md), D-006, spike 5's "Windows" analysis, spike 10's last open item): the whole stack (QuickJS host, Node shims, process model, main-process shim, software renderer) has only ever run on Linux. What does it take to run it on Windows 7, 32-bit, with a real window and no runtime to install?

- **Almost everything below ran under Wine 9.0 on Linux (cross-compiled with mingw-w64).** Wine is not Windows; it found real bugs (Win32 error codes, module identity) but can hide others. The self-test package (`package/`, `host/package_win.sh`) was then run on a **real Windows 7 Professional, build 7600 (no service pack), x86, 2 GB RAM, 2 vCPUs of an AMD Ryzen 5 5600G VM**: all 5 tests (host start, processes/pipes/IPC/kill, `child_process.fork` through the Node shims, `net` over named pipes, the GDI window) **passed unchanged** (`results/win7-vm/`). The window log shows every event type arriving with the right coordinates and codes: left/middle/right buttons with the button mask (including chords), wheel steps of ±120, key down/char/up with scan codes, Caps Lock toggling the case of the typed characters, Enter. Whether the gradient was drawn correctly was not reported (the log cannot show pixels). The web and desktop workbench have not yet been run there.
- **Target of the build:** Windows 7 SP1 and later, 32-bit (`-march=i586 -mno-sse -mno-sse2 -mno-mmx -mfpmath=387`, the baseline of spike 7) and 64-bit. Imports only `kernel32`, `user32`, `gdi32`, `msvcrt` (all present in a clean Windows 7; no Visual C++ runtime). **Windows XP is blocked by four functions** QuickJS itself imports (below).
- **Host:** QuickJS-ng 0.17.0 + the spike 5/7 native modules; the same JavaScript as on Linux.

## Verdict

1. **The host cross-builds and runs on Windows** (1.6 MB exe). The stock QuickJS compiles for mingw with a small patch of `quickjs-libc.c` (four hunks in the Windows poll loop); the spike 7 rasterizer and layout engine needed one change (a timer, `render.c`) and render **the same pictures**: the web workbench boot of spike 8 runs on the .exe under Wine and reaches the same Welcome / chat screen.
2. **A native process/pipe layer for Windows (`winproc.c`, ~600 lines of C) replaces POSIX `proc.c` behind the same JavaScript.** Overlapped named pipes, `CreateProcess` with handles passed by value, waitable process handles, named-pipe servers: `child_process.fork()` with an IPC channel (the spike 5 tests: JSON messages up to 280 KB, stdio pipes, disconnect, kill, spawn failure), `net` over `\\.\pipe\...`, `spawnSync`, 2.5 MB through a pipe — all pass (`results/`). This is the part of spike 5's "Windows event loop" analysis that was open; it is solved without changing QuickJS beyond the event-loop hook.
3. **A Win32 window (`winwin.c`, ~145 lines, GDI only).** The framebuffer of the native rasterizer is blitted with `BitBlt`; mouse (with capture and hover tracking), wheel, keyboard (virtual keys, `WM_CHAR` text) and size events reach JavaScript from inside the QuickJS event loop (the loop waits with `MsgWaitForMultipleObjects`). `window_host98.mjs` turns them into DOM events (hit testing with `elementFromPoint`, focus, `keydown`/`input` for Monaco's input area).
4. **The desktop workbench of spike 10 runs on the Windows .exe under Wine in a window**: main process (VS Code's own electron-main bundle, Windows code paths: `isWindows` branches in `mainImpl.js`), shared process, file watcher, extension host, agent host (crashes, as on Linux), renderer; F1 typed on the X keyboard through Wine opens the real Command Palette (`results/desktop-window-wine.png`). The headless run settles in 76 s under Wine (Linux native: 60 s for spike 10's folder run); a real Windows number is not known.
5. **What it still needs is host work and a real machine:** TCP sockets (Winsock), `.cmd`/`.bat` spawning, the XP condition-variable gap, Windows 9x (no `W` APIs, no overlapped pipes), native addon stand-ins, and every number on real hardware. See "Gaps".

![desktop workbench in a Win32 window (Wine)](results/desktop-window-wine.png)

## What was built

**Native (`host/`)**

| File | Lines | What |
|---|---|---|
| `build_win.sh` | | cross-build with mingw-w64: patched `qjs.c` (spike 7's seds + `spike_init_win`), a patched copy of `quickjs-libc.c`, spike 5's `esm.c`, spike 7's `render.c`/`layout.c`, `winproc.c`, `winwin.c`; 256 MB stack reservation (`--stack`), static libgcc |
| `patch_libc.py`, `winhook.h` | 40 | the hook: QuickJS's Windows poll loop only waits on stdin and worker ports; the patch asks `js_win_waiter` for extra handles (pipes, process handles, events), dispatches to it when one is signalled, keeps the loop alive while it has work, and waits with `MsgWaitForMultipleObjects` while a window exists |
| `winproc.c` | ~600 | module `spike:proc`, same names and conventions as the POSIX one (negative Linux errno values, `EAGAIN = -11`): `pipe(childEnd)`, `socketpair`, `read`/`write`/`close`/`setReadHandler`/`setWriteHandler`, `spawn`, `watchExit`, `kill`, `pollSync`, `listenUnix`/`accept`/`connectUnix` for named pipes, `rename` (replace-existing), `exePath` |
| `winwin.c` | ~145 | module `spike:win`: `create`, `present`, `setHandler`, `setCursor`, `setTitle`, `size`, `screenSize`, clipboard get/set |
| `check_imports.sh` | | lists the DLL imports and flags functions that do not exist before Vista |

**JavaScript**

- `window_host98.mjs`: window ⇄ DOM (events, repaint when `doc.__dirty`, cursor from `getComputedStyle`).
- Shim changes (shared with Linux; Linux behaviour unchanged): the `path` shim is now VS Code's own port of Node's path module (`vspath.js`, generated by `host/build_path.sh`; win32 flavour on Windows) with `fromFileUrl`/`toFileUrl`; `url`, `os`, `module` (`node_modules` lookup), `process.platform/cwd`, `fs` (recursive `mkdir`, `lstat` fallback, Win32 error codes, replace-on-rename, fd functions already from spike 10), `events` unchanged; `fdio.js` routes descriptor I/O to `spike:proc` on Windows; `child_process` (exit via process handles, `shell` through `%ComSpec% /d /s /c`, verbatim arguments); ESM loader (module names canonical with `/`: a module loaded under two spellings is instantiated twice, which silently split `Module.__hooks` in the first attempt).
- Desktop harness: `--window 1` (paths, `vscode-file://vscode-app/c:/...`, stand-ins for Windows-only native packages: policy-watcher, native-keymap, windows-mutex/registry/process-tree, native-is-elevated, foreground-love).
- `host/package_win.sh` + `package/selftest.cmd`: a relocatable test package (6.7 MB).

## Results (all under Wine; `results/`)

| Test | Result |
|---|---|
| `tests/proc_raw.mjs` (spawn, stdio pipes, duplex IPC pipe, exit codes, kill, ENOENT, pollSync, 2.5 MB backpressure) | 10/10 pass |
| spike 5 `fork_parent.cjs` through the Node shims (`fork`, IPC messages up to 280 KB, disconnect, kill, spawn error) | pass |
| `tests/net_pipe.cjs` (named-pipe server, 3 concurrent clients, 300 KB echo, missing pipe → ENOENT, `server.close`) | 4/4 pass |
| `tests/win_gdi.mjs` under Xvfb + xdotool (window, gradient blit, mouse down/up/move, wheel, key down/char/up, backspace, ctrl+A) | events and pixels as expected |
| web workbench boot (spike 8) on the .exe | boots to the same screen as on Linux (968 elements, 157 layout passes) |
| desktop workbench boot headless on the .exe (main + utility processes + renderer), no folder | 76 s until the DOM stops changing, 792 elements, 227 layout passes, 63 rects painted |
| desktop workbench in a window: F1 → Command Palette | works |
| x86 exe size / DLL imports | 1.6 MB; KERNEL32, USER32, GDI32, msvcrt |

## How to run it on a VM

1. Windows 7 SP1 32-bit, 2 GB RAM, 2 vCPUs, 1280×800, no 3D (the spec given in the conversation).
2. Unzip `dist/vscode98-win-selftest-x86.zip` (built by `host/package_win.sh dist-dir x86`; not committed, it is a build product) anywhere and run `selftest.cmd` in `cmd.exe`. It writes `results\` (system info, one text file per test). The window test needs you to move the mouse over the window, click, scroll and type for 15 s.
3. Send `results\` back. The desktop workbench is a second package (`host/package_desktop.sh`, 42 MB zipped, 166 MB unpacked: the app bundle without source maps, the 60 `node_modules` packages the app loads with their native binaries emptied, `theme-defaults` and the git extension's compiled output): unzip, run `run-desktop.cmd [width height]` (default 1000×700; the VM's screen is 1024×768) and send `results\desktop.txt`. Under Wine the package boots to the Explorer with the sample folder in a window (802 elements after 42 s, still filling).

**First real-Windows desktop run (Windows 7, build 7600): the window stayed blank** (8 elements, 0 layouts, `TypeError: cannot read property '__nid' of null` in the native font registry). Cause: the renderer's font table names Linux paths (`/usr/share/fonts/...`) and `loadFile` returned null for all of them; under Wine those paths resolve to the Linux host's real font files, so the bug was invisible there. Fix: `globalThis.__fontRoot` relocates the table (`--font-dir`, default `<package>/fonts`), the package ships DejaVu, Liberation and Inter (18 MB, licences in `fonts/LICENSES`), and the Wine run was repeated with `/usr/share/fonts` renamed away: the workbench renders completely from the bundled fonts. Two smaller findings from the same log: `@github/copilot-sdk` is missing in the package (agent host, expected: it crashed on Linux already, now it fails at resolution), and `mkdir` of an existing directory reported EEXIST once on Windows (a raw Win32 code; now re-stat after a failed `mkdir`).

## Gaps and findings

| | |
|---|---|
| **Only partly verified on Windows** | the process, pipe, fork, named-pipe and window-event tests pass on a real Windows 7 (build 7600, x86, 1024×768 screen); the picture drawn in the window, the web/desktop workbench and all timings were only run on Wine so far. The VM's screen is 1024×768: the 1280×800 default window of the desktop harness does not fit, use `--width 1000 --height 700`. Known differences that matter: Wine's named pipes, overlapped I/O and `MsgWaitForMultipleObjects` are re-implementations; GDI under Xvfb has no DWM/Aero; process creation timing; DPI virtualization (the exe calls `SetProcessDPIAware` when present) |
| **Windows XP does not load the exe** | QuickJS imports `InitOnceExecuteOnce`, `InitializeConditionVariable`, `SleepConditionVariableCS`, `WakeConditionVariable` (Vista+, for worker threads / `Atomics.wait`). Everything of mine avoids Vista-only calls (`check_imports.sh`). Fix: replace the four with `GetProcAddress` fallbacks built on events and a critical section (a small patch of `quickjs.c`/`quickjs-libc.c`'s pthread-like layer) |
| **Windows 9x** | not started: no `W` entry points (all of `winproc.c`/`winwin.c` use them) and no overlapped I/O on pipes (NT only). The thread-based reader for non-overlapped handles already exists (it is what handles inherited std handles), so pipes can be done with threads; `CreateProcess` + handle inheritance exist on 95/98 |
| **TCP / `dgram` / `tls`** | `listen`/`connect` by host and port return ENOSYS (needs Winsock with `WSAEventSelect` handles in the same wait set). Named pipes (what VS Code uses on Windows for its own IPC) work |
| **Pipe half-close** | a pipe has none: `socket.end()` sends the queued data, then closes the whole handle; a peer that keeps sending after our `end()` is lost |
| **`.cmd` / `.bat`** | `spawn` without a shell cannot start them (as in Node ≥ 20.12); `shell: true` goes through `cmd.exe` |
| **Symlinks, `lstat`** | QuickJS has none on Windows; `lstat` is `stat` |
| **Wait set limit** | 64 handles (`MAXIMUM_WAIT_OBJECTS`): fine for a workbench (a dozen pipes), a concern for many sockets |
| **Native addons** | still the spike 10 stand-ins (JSON storage instead of SQLite, polling watcher) plus new ones for the Windows-only packages; `@vscode/spdlog` stub means no log files |
| **Agent host** | crashes at start-up as on Linux (out of scope on old Windows, D-008) |
| **Speed** | Wine: 76 s to settle (Linux native 60 s with a folder, 28 s without). Real hardware unknown |
| **Startup of the window** | the first paint happens after the workbench's own start-up; a window with a splash would show something earlier |

## Files

`host/{build_win.sh, patch_libc.py, winhook.h, winproc.c, winwin.c, window_host98.mjs, check_imports.sh, build_path.sh, package_win.sh}`, `tests/{proc_raw.mjs, net_pipe.cjs, win_gdi.mjs}`, `package/selftest.cmd`, `results/`. Changed in other spikes: `02-node-shim/host/{globals.js, impl/{path,os,url,module,fs,events,crypto,vspath}.js, gen_shims.mjs}`, `05-child-process/host/{esm_loader,fork_main,proc_setup,build_impl}.mjs`, `05-child-process/host/impl/{child_process,fdstreams,net,fdio}.js`, `05-child-process/tests/fork_parent.cjs`, `07-native-render/host/render.c`, `10-main-shim/host/*` (hooks, stubs, harness).

## Desktop run diagnostics (window mode)

`--status-every N` (default 15 s) logs `[status] t= elements= layoutPasses= paints=` and the **working set of the whole process tree** (`processTree` in `winproc.c`: Toolhelp snapshot + `GetProcessMemoryInfo`, which is Windows 7 or later), and `--shot-at 60,150,300` writes `results\window-<s>s.bmp` (24-bit BMP, open it with Paint) so a run can be judged from `desktop.txt` and the bitmaps alone. Under Wine: 396 MB at 21 s (8 elements), 619 MB at 39 s (802 elements), 674 MB at 51 s (873 elements, 118 layout passes).

### First complete desktop run on real Windows 7 (build 7600, x86, 2 GB, `results/win7-vm/`)

The bundled-font package renders the **complete desktop workbench on Windows 7** (`desktop-60s.png`, `desktop-300s.png`: Explorer with the sample folder, activity bar, status bar, chat panel and the Copilot welcome dialog, the same picture as under Wine): the real electron-main bundle, shared process, extension host, file watcher and renderer, all on the 1.6 MB exe.

| | Windows 7 VM | this sandbox (Wine) |
|---|---|---|
| until the UI exists (802 elements), counted from the window opening | 64 s | 39 s |
| working set of the whole process tree at that point | 573 MB | 619 MB |
| renderer process (QuickJS: DOM, style, layout, raster) | 508 MB at 64 s, 513 to 652 MB later | 518 to 653 MB |
| main / shared process / extension host / watcher | 29 / 27 / 10 MB (+ 37 to 39 MB) | 39 / 37 / 20 MB |
| settled state | 911 elements, 393 layout passes after 111 s | 911 elements, 356 passes |

**Bug found by the VM's status lines:** the idle workbench was repainted about 12 times a second (paints 50 → 2428 over 200 s with no layout pass), and the renderer's working set swung between 513 and 652 MB. `present()` makes Windows send `WM_PAINT`, the window forwarded it as a `paint` event and the DOM driver repainted on every event, including that one. Fixed (no repaint on `paint`/`focus`/`leave`) and the 4 MB backend buffer is reused (`NativeBackend.reset()`); after the fix an idle workbench paints 0 times (5 paints in 138 s under Wine, flat memory).

### Interaction on the VM, round 1 (desktop package v4): clicks work, the editor does not, file open takes 30 s

The VM report: files in the Explorer can be clicked, the editor shows the I-beam cursor, but typing, clicking into the text and selecting do nothing, and the text of an opened file shows up about 30 s after the click. Reproduced and fixed with a headless scenario (`10-main-shim/host/scenario_click.mjs`: open a file, then press at real coordinates with the same pointer + mouse events the window host sends) and with `xdotool` against the real window under Wine (`--debug-input 1` logs every window event, the element under the pointer and `document.activeElement` before/after each press).

Root causes, in the order they were found:

1. **The file text appeared late because the window was painted only when `doc.__dirty` was set.** Code that reads geometry (Monaco measures all the time) runs a layout pass itself and clears the flag, so most changes were never painted until something else dirtied the document. The tick now paints whenever a layout pass has run since the last paint (`doc.__passStats.length`).
2. **Clicks into the editor text were ignored because our DOM had no `ELEMENT_NODE`/`TEXT_NODE` on instances.** Monaco writes `child.nodeType === child.ELEMENT_NODE`; browsers define the node-type constants on `Node.prototype`, our `Node` only had them as statics. `PartFingerprints.collect()` therefore returned an empty path for every target, the mouse hit test fell through to "unknown" (inside a `try/catch` that swallows everything), nothing focused Monaco's hidden `textarea`, and the window host's own default action (blur the active element, since nothing focusable was under the pointer) left `activeElement` at `body`. Keys went to `body`. `dom.js` now defines the constants on the prototype.
3. **`document.caretRangeFromPoint` returned `null`.** The hit test of the text itself (`_doHitTestWithCaretRangeFromPoint`) needs the character offset under the pointer. Implemented in `env.js` on the layout's text fragments (nearest fragment on the line containing `y`, nearest character boundary in `x`).
4. Pointer events: Monaco's editors listen to `pointerdown`/`pointermove`/`pointerup` (drag selection) as well as `mousedown`; the window host now sends the pointer event first, then the compatibility mouse event (skipped, as in browsers, when `pointerdown` was cancelled), and focuses the clicked control only if the press was not cancelled (Monaco cancels it and focuses its own input area).

Result under Wine + Xvfb + xdotool on the real window: click `hello.txt`, click into the text, type `abc` → `helloabc vscode98`, caret drawn, tab shows the modified dot.

**File open time** (scenario `scenario_edit`, Linux, QuickJS-ng, 55 to 98 layout passes): 12.5 s → 6.6 s. Two changes: the per-rule part of the rule index (parsed selectors, expanded declarations, Bloom-filter bits) is cached per `CSSStyleRule` so the index rebuilds that follow every `<style>` change (24 to 40 during boot, 14 to 16 k rules each) only allocate the entries again; and `analyzeIndex` is incremental (it scans only the selectors it has not seen; its result only ever grows, and it starts over when most of what it remembers is gone). Both keep the spike 9 fuzzer at 0 mismatches (7,500 passes). What is left of the 6.6 s: style 4.2 s (rule index 1.0 s, planning 0.5 s, **matching 1,400 restyled elements about 1.6 ms each**, computed styles 1.0 s) and layout 1.4 s. The first click restyles 481 elements at once (a class on a high container changes). One walk over the candidate lists now serves an element and its two pseudo-elements (`matchedDeclarationsAll`). Next, if it is still too slow on the VM: bucket the 282 universal-bucket rules (168 are `:is(...)`) by the keys of their arguments, which are 56 % of the 5 M candidates tested per boot (97.6 % of the tests that pass the Bloom filter fail), and a native matcher.

**Confirmed on the VM with package v5** (`results` of the user's run): typing lands (`helloabc`/`testing 3`), the editor takes focus on a click (`active-after=textarea.inputarea`), double-click and drags are handled, no listener errors. The opened file's text appeared within about 20 s of the click (v4: 30 s).

### Interaction and boot speed, round 2 (package v6)

The VM report: boot is slow, a click into the editor takes a few seconds to react, typing is slow. A profile of the settled workbench on the sandbox (`10-main-shim/host/scenario_keys.mjs`: busy time of a click and of every key split into event handling, frame callbacks, style, layout, paint, the way the window host drives the document; `scenario_match.mjs`: selector matching on the settled DOM against the plain matcher as oracle) showed:

- **Selector matching dominated restyling** (0.78 ms per element; 5 M candidate rules considered per boot, 97 % failing at the subject compound). 168 universal-bucket rules were `:is(...)` compounds, 578 rules sat in the `.codicon` bucket. Fixes in `css.js`/`selectors.js`: rules whose subject is `:is()`/`:where()`/`:root` are filed under the keys of their alternatives; multi-class compounds under the rarest class; "one of" ancestor Bloom groups for `:is()` compounds in the ancestor part (131 k of 147 k failing descendant climbs had one); a per-pass memo of "does this element or an ancestor match this compound". Matching per element 0.78 → 0.31 ms (microbenchmark, 0 mismatches against the plain matcher).
- **Rule index** (every `<style>` change used to rebuild 12 to 16 k entries and diff them by signature: 10.4 s of the 54 s boot): `diffIndex` now compares by rule identity, the index is extended in place when only the tail of the rule list changed (entries are the last of their buckets, so they can be popped), `analyzeIndex` only scans new entries. 10.4 s → 3.6 s.
- **Planning** spent 10 ms per pass in `shapesMatch` (hundreds of shapes from `:first-child`-style rules, each tried against every inserted element): shape lists are now indexed by id/class/tag.
- **The big one: AI features.** The chat panel, welcome dialog, agent status bar and secondary side bar were half of the boot's layout passes (322 → 66), elements (1,011 → about 500) and style+layout time (25 s → 8 s). The AI features are out of scope for old-Windows builds (D-008); the harness now seeds `chat.disableAIFeatures`, a hidden secondary side bar, no command center, no layout controls, no breadcrumbs/minimap/tips/experiments into a fresh user `settings.json` (only when none exists). The result is the classic VS Code window (menu bar in the title bar, Explorer, editor, status bar).

Sandbox numbers (Linux x86-64 QuickJS, the same code as the Windows host): workbench ready (UI and settled) 36 s → about 19 s; click into the editor 0.9 s → 0.5 s of work, steady-state key 55 ms → about 50 ms including paint at half the element count; file open 12.5 s → 3.5 s. Compiler flags are not the lever: SSE2, i686 and `-O3` builds ran within noise of the i586 build (Wine: boot 60 to 69 s, matcher 340 to 378 ms).

**The VM is much slower than the sandbox.** The workbench reaches about 800 UI elements after about 12 s natively, about 40 s under Wine here and about 127 s on the VM (VirtualBox, 2 GB, 2 vCPUs of a Ryzen 5 5600G, 128 MB video, VT-x, Hyper-V paravirtualization). `bench.js` / `run-bench.cmd` (ten micro-benchmarks, about 9 s here, 16 s under Wine) are in the package to tell whether that is general VM slowness or something specific.

Also found: the window host opens after the script import but the whole workbench build is one long synchronous stretch, so the first `[status]` line (and the 60 s screenshot) arrives late; `--progress <s>` logs a timeline in any mode.
