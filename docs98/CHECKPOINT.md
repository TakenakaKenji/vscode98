# Checkpoint — Resume Here

**Last updated:** 2026-10-12, after Phase 1 spike 6 (DOM + CSS + layout + software renderer: Monaco and a static workbench replay), on top of spike 5 (child processes, IPC, sockets and a native ES-module loader on QuickJS-ng), spike 4 (WebAssembly), spike 3 (extensions via `require()`), spike 2, spike 1 step 1, the bundle baseline and the finished process-side trace. Work is on branch `claude/adoring-heisenberg-ipwnb8`; check `git status` / `git log origin/main..` for anything unpushed (the cloud session could not push for a while: GitHub access 403).
Update this file at the end of each working session (what's done, what's next, what to watch for).

## Where we are

**Phase 0 (setup and inventory) is mostly done. No host code has been written yet.** Nothing in `src/` has been modified; all work so far is docs, scan/trace scripts, and measurements of stock VS Code 1.142.0.

Goal recap ([01-goal-and-scope.md](01-goal-and-scope.md)): full VS Code feature set, Electron-free, "physically possible" rather than "feasible", staged Win 7 → XP → 98. AI/agent/cloud features are scoped out of old-Windows builds (D-008, accepted); the Claude Code extension won't run there and the owner will work around that later.

### Done
- Fork cloned (shallow) at `~/Documents/GitHub/vscode98`, `upstream` remote added, docs in `docs98/`.
- Static inventory of Electron, Node, DOM/CSS/Web, native modules, JS level ([inventory/README.md](inventory/README.md)).
- Built stock VS Code on the Fedora dev machine and ran it headless ([inventory/baseline-build.md](inventory/baseline-build.md)).
- **Measured renderer traces:** startup ([runtime-trace.md](inventory/runtime-trace.md)), 9 feature scenarios ([runtime-trace-scenarios.md](inventory/runtime-trace-scenarios.md)), markdown webview ([runtime-trace-webview.md](inventory/runtime-trace-webview.md)).
- **Measured Phase 1 spike 6 (rendering engine, no GDI):** [spikes/06-rendering/README.md](spikes/06-rendering/README.md). A pure-JS DOM + CSS + layout + software painter (~210 KB) runs the real, unmodified Monaco on QuickJS-ng: geometry equals headless Chromium's (every non-SVG box within 0.5 px in 4 scenarios, mean pixel error 0.1 to 1.4/255), framebuffers byte-identical on Node and QuickJS. A static replay of the real workbench (captured DOM+CSS; its JS did not run on our DOM) puts 422 of 566 boxes within 1 px; remaining gaps are known (title bar `env()`, Inter kerning, SVG, shadows, rotation, Canvas 2D). On QuickJS one cold workbench pass is 7.3 s style+layout and 3.3 s paint (5.7× and 11× slower than Node): layout and rasterization have to become native. Nothing was drawn through GDI or run on Windows.
- **Measured Phase 1 spike 5 (child processes, IPC, net, ESM loader):** [spikes/05-child-process/README.md](spikes/05-child-process/README.md). A native layer of 374 lines of C (`spawn` with an fd map, pipes, socketpair, TCP/unix sockets, `poll`-based sync I/O, native UTF-8, module resolver/loader hooks, sync `require(esm)`) plus ~550 lines of JS give `child_process` (fork with IPC, exec, sync variants), `net`, `readline` and Node ESM resolution on QuickJS-ng. Real tsserver returns Node's answers (6.0× slower, idle child 4 MB vs 39 MB), the JSON/CSS/HTML/Markdown language servers run via their real clients, git runs real `git`; **29 of 34** built-in extensions activate, no pre-bundling. Linux only: QuickJS's Windows poll loop waits only on stdin/worker ports, so pipes/sockets need a host-owned loop there.
- **Measured Phase 1 spike 4 (WebAssembly):** [spikes/04-webassembly/README.md](spikes/04-webassembly/README.md). `onig.wasm` runs on QuickJS-ng three ways (wasm3 interpreter with a custom `WebAssembly` API, native libonig, wasm2c-translated C) with identical results on 68,741 recorded calls plus edge cases, x86-64 and x86-32. Native/wasm2c ≈ V8 per call; wasm3 8× slower per call and 2.6× (x86-64) to 4.9× (x86-32) slower for TextMate tokenization end to end. Tokenizing 8,482 lines: V8 1.4 s, QuickJS+native 4.6 s. Tree-sitter is experimental and default-off; not shown to run on wasm3. Nothing was built for Windows.
- **Measured Phase 1 spike 3 (extension loading):** [spikes/03-extension-loading/README.md](spikes/03-extension-loading/README.md). 24 of 34 built-in extensions load via `require()` and activate on QuickJS-ng (incl. git, typescript-language-features); 4 language-client extensions load fully then block on `child_process.fork`; no sync `require(esm)` (4 ESM-only deps pre-bundled), ESM extensions need a native resolver hook.
- **Measured Phase 1 spike 2 (execution speed, Node-side shim):** [spikes/02-node-shim/README.md](spikes/02-node-shim/README.md). QuickJS-ng 8.5× slower than V8 JIT, 2.2× slower than V8 jitless, identical results; extension host/shared process/pty host/watcher bundles boot on QuickJS-ng; extension host completes the handshake and sends its first 10 RPC requests.
- **Measured Phase 1 spike 1, step 1 (JS engine, compile-only):** [spikes/01-js-engine/README.md](spikes/01-js-engine/README.md). QuickJS-ng 0.17.0 parses all 30 bundle files unmodified; gaps `Intl`, `WebAssembly`, `structuredClone`; ES2015 lowering floor; compile cost makes precompiled bytecode necessary.
- **Measured production bundle baseline:** bundle size/JS level, startup time and memory, bundled vs dev ([inventory/baseline-bundle.md](inventory/baseline-bundle.md)).
- **Measured process-side trace:** Node + Electron API usage of the main process, 5 utility processes and 5 language-server/worker Node children during the same scenarios ([runtime-trace-processes.md](inventory/runtime-trace-processes.md)). Re-run 2026-10-12 after fixing two hook defects (see that doc); the first run's "75 Electron entries" was an undercount, the correct figure is 102.

### Key measured facts (details in the linked docs)
- Electron is imported in ~52 files (47 in `electron-main`); the renderer reaches it via one preload bridge (`src/vs/base/parts/sandbox/electron-browser/preload.ts`).
- ~312 distinct DOM/Web members were called across startup + 9 scenarios; 227 distinct standard CSS properties; layout is block/inline/flex/absolute (no grid, no sticky live).
- Editor input is a `<textarea>` (no contentEditable) but needs the full legacy keyboard event model; Canvas 2D and `OffscreenCanvas` are used (no WebGL); legacy WebKit APIs are used (`caretRangeFromPoint`, `wheelDelta*`).
- WebAssembly is required (syntax highlighting).
- Process side: the app calls only 119 distinct Node functions (~13 modules) and 102 Electron methods/events (incl. `webContents`/`session`/`utilityProcess`); renderer↔main IPC is one multiplexed `vscode:message` channel plus ~3 MessagePort handoffs; the renderer's files are served through the `vscode-file://` protocol (`net.fetch`); programs launched: `rg`, `git`, `tsserver`, shells.
- Webviews = iframe-in-iframe on a `vscode-webview:` origin + service worker; need a real HTML engine (incl. table layout, `@layer`, web fonts).
- Emitted JS is ES2024 ES modules, not downleveled. **The production bundle is the same:** 58 MB of minified ES2024 ES modules in 30 files (target `es2024`; workbench 20.6 MB); still static/dynamic `import` and `import.meta`.
- **Baseline (Linux, 4-core VM, headless, bundled, empty workspace):** time to ready 2.4 s (dev mode 12.8 s); ~1.3 s of the ~2.0 s renderer time to "restored" is loading the workbench bundle; idle 10 processes, 1.5 GB RSS / 0.84 GB PSS, renderer JS heap ~78 MB. The workbench alone already exceeds the RAM budget of the oldest targets ([03-targets-and-limits.md](03-targets-and-limits.md)).

### Not done yet (open)
- Inventory pass 2: built-in `extensions/`, `build/`, finer CSS inventory.
- Full packaging (`vscode-linux-x64-min`, with marketplace built-in extensions, V8 code cache) and a baseline taken on a real Windows machine; the staged-bundle baseline is an approximation ([baseline-bundle.md](inventory/baseline-bundle.md)).
- Other webview types (notebooks, custom editors, simple browser); API counters inside webview frames.
- More scenarios: drag-and-drop, clipboard, IME, context menus, git, extensions view, debugging, notebooks.
- Windows build/test environment (VM or machine): **not set up**. Everything so far ran on Linux.
- Deepen git history / fetch upstream tags (`git fetch upstream --tags`) if an old-tag reference build is wanted.
- Phase 1 feasibility spikes ([04-roadmap.md](04-roadmap.md)): JS engine (QuickJS-ng or other), minimal DOM/layout/GDI render, Node shim, downleveled build. **Decisions D-003 to D-006 are still `proposed`** ([05-decisions.md](05-decisions.md)).

## What the process-side finish added (2026-10-12)
- Language-server children (2× `tsserver`, `typingsInstaller`, JSON server, markdown worker) are now traced. New hard requirements they show: a working `child_process.fork` **with an IPC channel** (`process.send`, `on('message')`, `on('disconnect')`) and fast **synchronous** `fs.statSync/readdirSync/existsSync` (tsserver makes ~19k `statSync` calls in 90 s). They load no native addons. The typings installer shells out to `npm`.
- `webContents`/`session`/`utilityProcess` are now measured: the Electron surface is **102** entries, not 75. The earlier gap came from a swallowed exception on `electron.screen` in the hook, not from instance-level methods.
- Hook changes: `node_hook.cjs` injects itself into Node children (VS Code strips `NODE_OPTIONS` from them), patches each Electron module separately (retry after `ready`), and has a debug aid `VSCODE98_TRACE_SHAPES=1`. `analyze_proc_trace.py` names children by script and reports `nodeChildLaunchesByParent`.

## Suggested next steps (in order)
1. ~~Finish the process-side trace~~ done 2026-10-12.
2. ~~Production bundle build + memory/startup baseline~~ done 2026-10-12 ([baseline-bundle.md](inventory/baseline-bundle.md)). Not done: full packaging (`vscode-linux-x64-min`, marketplace built-in extensions), baseline on a real Windows machine.
3. ~~Decide the Phase 1 spike order~~ agreed 2026-10-12: (1) JS engine load test [step 1 done], (2) Node shim + `tsserver` benchmark on QuickJS (execution speed; boot the extension-host bundle on a shim), (3) WebAssembly (wasm3 vs native bindings), (4) rendering. Step 2, extension loading (spike 3), WebAssembly (spike 4), child processes (spike 5) and the rendering engine (spike 6, JS only) done 2026-10-12. **Next candidates: (a) native layout + rasterizer and a first GDI backend (spike 6 shows JS layout/paint is 5.7× to 11× too slow on QuickJS), or running the real workbench on the DOM (events, focus, IME, Canvas 2D), (b) a Windows build of the native layer: host-owned event loop for pipes and sockets (IOCP / Win9x), `CreateProcess` with inherited handles. Order is the owner's call.** Note for the native-host work: Oniguruma should be linked in natively (or via wasm2c) rather than via a WASM interpreter.
4. Set up a Windows 7 VM/machine for real testing before writing host code.

## How to resume the dev environment

State on the dev machine (all gitignored, may need rebuilding on a different machine): `node_modules/` (1.6 GB), `out/`, `.build/electron/`, compiled `extensions/*/out`, built extension media, codicon font copies.

```bash
cd ~/Documents/GitHub/vscode98
git pull                              # if working from another machine
# only if node_modules/out are missing:
sudo dnf install -y krb5-devel libX11-devel libxkbfile-devel libsecret-devel   # one-time, root
npm ci
npm run transpile-client              # ~25 s
npm run gulp compile-extensions       # ~32 s
npm run gulp compile-extension-media  # ~10 s, REQUIRED for webviews
npm run electron                      # downloads Electron to .build/electron
cp node_modules/@vscode/codicons/dist/codicon.ttf src/vs/base/browser/ui/codicons/codicon/ && cp node_modules/@vscode/codicons/dist/codicon.ttf out/vs/base/browser/ui/codicons/codicon/
# re-run traces (headless, throwaway profile and workspace copy):
PROC_TRACE=1 bash docs98/inventory/scripts/run_scenarios.sh /some/workdir 9333       # + per-process Node/Electron trace (then analyze_proc_trace.py)
bash docs98/inventory/scripts/run_scenarios.sh /some/workdir 9333                      # 9 scenarios
bash docs98/inventory/scripts/run_scenarios.sh /some/workdir 9333 trace_webview.mjs    # markdown webview
```

### Rebuilding in a Claude Code cloud container (Ubuntu 24.04), done 2026-10-12
The image has Node 22 and no build deps; the repo needs Node 24.18.0 (`.nvmrc`). What worked:
```bash
apt-get update && apt-get install -y libkrb5-dev libxkbfile-dev libsecret-1-dev libx11-dev libxss1 libgtk-3-0 libnss3 libgbm1 pkg-config ripgrep
# Node 24.18.0 from nodejs.org into a scratch dir; put its bin first on PATH for every command below
node build/npm/preinstall.ts && npm ci --ignore-scripts
mkdir -p node_modules/@vscode/ripgrep/bin && ln -sf /usr/bin/rg node_modules/@vscode/ripgrep/bin/rg   # skips the ripgrep postinstall (see below)
npm rebuild && node build/npm/postinstall.ts      # if extensions/ or extensions/copilot nested installs fail, run `npm ci` in extensions/ and re-run postinstall
npm run transpile-client && npm run gulp compile-extensions && npm run gulp compile-extension-media && npm run electron
cp node_modules/@vscode/codicons/dist/codicon.ttf src/vs/base/browser/ui/codicons/codicon/ && cp node_modules/@vscode/codicons/dist/codicon.ttf out/vs/base/browser/ui/codicons/codicon/
```
- Network policy must allow `electronjs.org` (native-module headers; it redirects to `artifacts.electronjs.org`) (`npm run electron` then downloaded the Electron zip without further changes; the serving host was not checked). `electronjs.org` was blocked at first and had to be allowed in the environment's Network access settings.
- `@vscode/ripgrep`'s postinstall calls `api.github.com/repos/microsoft/ripgrep-prebuilt/...`, which the session proxy denies (403) for repositories that are not attached. The system `rg` (14.1.0) is used instead; fine for tracing, but it is **not** the version the product ships (15.0.1).
- The container is ephemeral: everything above must be redone in a new session. Consider a SessionStart hook / setup script if cloud sessions will be used regularly.

## Gotchas to remember
- `Trace/breakpoint trap` / `Trace/breakpoint` lines printed by the shell when a run ends are just the app group being killed with SIGTERM at the end (also noted in baseline-build.md); they are **not** a launch crash. An earlier note here claiming hand-launches crash was wrong: that run only looked broken because of the `electron.screen` hook bug (empty `shapes`).
- Do not trust a trace result that is suspiciously empty for a whole API group: the first process trace silently lost every Electron module after `screen`. `VSCODE98_TRACE_SHAPES=1` records the `webContents` layout and `shapes.deferredModules` / `shapes.patchErr` in the hook's per-process dump.
- `git-lfs` is not installed; the LFS filter is disabled in this clone's local `.git/config` (D-002). Don't re-enable it without installing git-lfs.
- Dev-mode runs create `~/.vscode-oss-shared/` in the home directory (outside the temp profile). Safe to delete.
- The tracers use headless Electron with `--no-sandbox` and synthetic CDP input. A windowed run on Wayland has **not** been tried; the headless run is verified working on Fedora 44.
- Counts from static greps over-approximate; prefer the runtime traces where they disagree ([inventory/README.md](inventory/README.md)).
- Dev mode (unbundled `out/`) inflates module-loading counts (`new Blob`, `CSS.escape`, 400 stylesheets). Don't treat those as host requirements.
- `scripts/` contains scan scripts that read the repo; the traces use CDP over `--remote-debugging-port=9333` and need `chrome-remote-interface` from the repo's `node_modules`.
- The repo ships its own `.claude/CLAUDE.md` with upstream's coding guidelines (tabs, no `any`, etc.). Follow it when editing upstream TypeScript. Project docs live in `docs98/`, not in upstream files.
- `PROC_TRACE=1` temporarily prepends an import to the generated `out/bootstrap-fork.js` and restores it on exit. If a run is killed hard, run `npm run transpile-client` (or restore `out/bootstrap-fork.js`) to be safe. The hook is inert unless `VSCODE98_TRACE_DIR` is set.
- Electron main ignores `NODE_OPTIONS=--require` (use `-r file` on the command line); utility processes ignore `execArgv --require`.
- A bare `new BrowserWindow` in a minimal Electron test app segfaults in headless mode even without the hook; test hooks against the real VS Code, not toy apps.
- Scratch outputs of the traces were written to a temporary scratchpad and are **not** preserved; the committed copies are in `docs98/inventory/data/`.

## Open questions for the owner
- Which Windows machine/VM will be used for real testing (Win 7 first)?
- Is performance of a small JS engine acceptable if it makes VS Code slow on old CPUs? (The owner already noted CPU limits for the Claude Code extension.)
- Should webviews be treated as optional on the oldest targets, or a hard requirement?
