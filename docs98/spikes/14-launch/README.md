# Spike 14 — Launch timeline and bytecode cache

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

## Files

- `07-native-render/host/timeline98.h`; hooks in `07-native-render/host/build.sh` (Linux `quickjs-libc.c` patch), `11-windows-host/host/patch_libc.py`, `05-child-process/host/proc.c`, `11-windows-host/host/winproc.c`.
- `10-main-shim/host/timeline_report98.js`, `boot_desktop_qjs.mjs` (`--timeline`, `--code-cache`), `11-windows-host/package/run-desktop.cmd` (timeline on; keeps the previous log as `results\desktop-prev.txt`).
- `05-child-process/host/esm.c` (the cache).
