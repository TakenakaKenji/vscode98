# Checkpoint — Resume Here

**Last updated:** 2026-10-11, after the process-side trace (this session's commit follows `a9788173`, which is the last one pushed to `origin/main`, the fork `TakenakaKenji/vscode98`; check `git status` / `git log origin/main..` for anything unpushed).
Update this file at the end of each working session (what's done, what's next, what to watch for).

## Where we are

**Phase 0 (setup and inventory) is mostly done. No host code has been written yet.** Nothing in `src/` has been modified; all work so far is docs, scan/trace scripts, and measurements of stock VS Code 1.142.0.

Goal recap ([01-goal-and-scope.md](01-goal-and-scope.md)): full VS Code feature set, Electron-free, "physically possible" rather than "feasible", staged Win 7 → XP → 98. AI/agent/cloud features are scoped out of old-Windows builds (D-008, accepted); the Claude Code extension won't run there and the owner will work around that later.

### Done
- Fork cloned (shallow) at `~/Documents/GitHub/vscode98`, `upstream` remote added, docs in `docs98/`.
- Static inventory of Electron, Node, DOM/CSS/Web, native modules, JS level ([inventory/README.md](inventory/README.md)).
- Built stock VS Code on the Fedora dev machine and ran it headless ([inventory/baseline-build.md](inventory/baseline-build.md)).
- **Measured renderer traces:** startup ([runtime-trace.md](inventory/runtime-trace.md)), 9 feature scenarios ([runtime-trace-scenarios.md](inventory/runtime-trace-scenarios.md)), markdown webview ([runtime-trace-webview.md](inventory/runtime-trace-webview.md)).
- **Measured process-side trace:** Node + Electron API usage of the main process and 5 utility processes during the same scenarios ([runtime-trace-processes.md](inventory/runtime-trace-processes.md)).

### Key measured facts (details in the linked docs)
- Electron is imported in ~52 files (47 in `electron-main`); the renderer reaches it via one preload bridge (`src/vs/base/parts/sandbox/electron-browser/preload.ts`).
- ~312 distinct DOM/Web members were called across startup + 9 scenarios; 227 distinct standard CSS properties; layout is block/inline/flex/absolute (no grid, no sticky live).
- Editor input is a `<textarea>` (no contentEditable) but needs the full legacy keyboard event model; Canvas 2D and `OffscreenCanvas` are used (no WebGL); legacy WebKit APIs are used (`caretRangeFromPoint`, `wheelDelta*`).
- WebAssembly is required (syntax highlighting).
- Process side: the app calls only 118 distinct Node functions (~13 modules) and 75 Electron methods/events; renderer↔main IPC is one multiplexed `vscode:message` channel plus ~3 MessagePort handoffs; the renderer's files are served through the `vscode-file://` protocol (`net.fetch`); programs launched: `rg`, `git`, `tsserver`, shells.
- Webviews = iframe-in-iframe on a `vscode-webview:` origin + service worker; need a real HTML engine (incl. table layout, `@layer`, web fonts).
- Emitted JS is ES2024 ES modules, not downleveled.

### Not done yet (open)
- **Language-server children not traced** (`tsserver`, JSON server, worker forked by the extension host): the hook didn't reach them. Fix idea in [runtime-trace-processes.md](inventory/runtime-trace-processes.md) (wrap `child_process.fork/spawn` to add `--require`). Also `webContents`/`session` instance methods are unmeasured.
- Inventory pass 2: built-in `extensions/`, `build/`, finer CSS inventory.
- Production bundle (non-dev) build and baseline memory/startup numbers.
- Other webview types (notebooks, custom editors, simple browser); API counters inside webview frames.
- More scenarios: drag-and-drop, clipboard, IME, context menus, git, extensions view, debugging, notebooks.
- Windows build/test environment (VM or machine): **not set up**. Everything so far ran on Linux.
- Deepen git history / fetch upstream tags (`git fetch upstream --tags`) if an old-tag reference build is wanted.
- Phase 1 feasibility spikes ([04-roadmap.md](04-roadmap.md)): JS engine (QuickJS-ng or other), minimal DOM/layout/GDI render, Node shim, downleveled build. **Decisions D-003 to D-006 are still `proposed`** ([05-decisions.md](05-decisions.md)).

## Status of step 1 (finish the process-side trace), 2026-10-12, cloud session
- **Done, untested on VS Code:** `node_hook.cjs` injects itself into Node children (tsserver, language servers, workers) by wrapping `child_process`; `analyze_proc_trace.py` names children by script. Toy test under Node 24 passes.
- **Blocked:** the cloud container has no Electron/`out/`. `npm ci` fails because the network policy denies `electronjs.org` (Electron headers for native modules, 403 on CONNECT). The owner must allow `electronjs.org` (cloud environment settings → Network access → Allowed domains; Electron binary comes from `github.com` releases, which is reachable) or run the trace on the Fedora dev machine. Also needed in the container: Node 24.18.0 (downloaded to the scratchpad; the image has 22.22) and `libkrb5-dev libxkbfile-dev libsecret-1-dev` (installed via apt this session, not persistent).
- **Not started:** `webContents`/`session` instance-method capture (needs a running Electron).
- To finish, on a machine with the dev environment: `PROC_TRACE=1 bash docs98/inventory/scripts/run_scenarios.sh <workdir> 9333`, `python3 -I docs98/inventory/scripts/analyze_proc_trace.py <workdir> docs98/inventory/data/process-trace-summary.json`, then update `runtime-trace-processes.md` (children's Node surface, `nodeChildLaunchesByParent`) and INDEX.

## Suggested next steps (in order)
1. **Finish the process-side trace:** trace language-server children (tsserver etc.) and `webContents`/`session` instance methods (see gaps above). Optional, since the main picture is already clear.
2. Production bundle build + memory/startup baseline.
3. Decide the Phase 1 spike order (suggested: JS engine + WASM on the emitted bundle first, since it gates everything).
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

## Gotchas to remember
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
