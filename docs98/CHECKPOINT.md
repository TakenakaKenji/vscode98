# Checkpoint — Resume Here

**Last updated:** 2026-10-11, after commit `f0029157` (pushed to `origin/main`, the fork `TakenakaKenji/vscode98`).
Update this file at the end of each working session (what's done, what's next, what to watch for).

## Where we are

**Phase 0 (setup and inventory) is mostly done. No host code has been written yet.** Nothing in `src/` has been modified; all work so far is docs, scan/trace scripts, and measurements of stock VS Code 1.142.0.

Goal recap ([01-goal-and-scope.md](01-goal-and-scope.md)): full VS Code feature set, Electron-free, "physically possible" rather than "feasible", staged Win 7 → XP → 98. AI/agent/cloud features are scoped out of old-Windows builds (D-008, accepted); the Claude Code extension won't run there and the owner will work around that later.

### Done
- Fork cloned (shallow) at `~/Documents/GitHub/vscode98`, `upstream` remote added, docs in `docs98/`.
- Static inventory of Electron, Node, DOM/CSS/Web, native modules, JS level ([inventory/README.md](inventory/README.md)).
- Built stock VS Code on the Fedora dev machine and ran it headless ([inventory/baseline-build.md](inventory/baseline-build.md)).
- **Measured renderer traces:** startup ([runtime-trace.md](inventory/runtime-trace.md)), 9 feature scenarios ([runtime-trace-scenarios.md](inventory/runtime-trace-scenarios.md)), markdown webview ([runtime-trace-webview.md](inventory/runtime-trace-webview.md)).

### Key measured facts (details in the linked docs)
- Electron is imported in ~52 files (47 in `electron-main`); the renderer reaches it via one preload bridge (`src/vs/base/parts/sandbox/electron-browser/preload.ts`).
- ~312 distinct DOM/Web members were called across startup + 9 scenarios; 227 distinct standard CSS properties; layout is block/inline/flex/absolute (no grid, no sticky live).
- Editor input is a `<textarea>` (no contentEditable) but needs the full legacy keyboard event model; Canvas 2D and `OffscreenCanvas` are used (no WebGL); legacy WebKit APIs are used (`caretRangeFromPoint`, `wheelDelta*`).
- WebAssembly is required (syntax highlighting).
- Webviews = iframe-in-iframe on a `vscode-webview:` origin + service worker; need a real HTML engine (incl. table layout, `@layer`, web fonts).
- Emitted JS is ES2024 ES modules, not downleveled.

### Not done yet (open)
- **Process-side traces:** which Node built-ins, `process.*`, and Electron APIs the main, shared, and extension-host processes call at runtime. *This was the next step offered and deferred by the owner.*
- Inventory pass 2: built-in `extensions/`, `build/`, finer CSS inventory.
- Production bundle (non-dev) build and baseline memory/startup numbers.
- Other webview types (notebooks, custom editors, simple browser); API counters inside webview frames.
- More scenarios: drag-and-drop, clipboard, IME, context menus, git, extensions view, debugging, notebooks.
- Windows build/test environment (VM or machine): **not set up**. Everything so far ran on Linux.
- Deepen git history / fetch upstream tags (`git fetch upstream --tags`) if an old-tag reference build is wanted.
- Phase 1 feasibility spikes ([04-roadmap.md](04-roadmap.md)): JS engine (QuickJS-ng or other), minimal DOM/layout/GDI render, Node shim, downleveled build. **Decisions D-003 to D-006 are still `proposed`** ([05-decisions.md](05-decisions.md)).

## Suggested next steps (in order)
1. **Process-side runtime trace.** Instrument Node `require`/built-ins and `process.*` in the main, shared, and extension-host processes, run the same scenarios, and write `inventory/runtime-trace-processes.md`. Electron's utility processes can be inspected with `--inspect-brk-extensions` / `--inspect-brk-sharedprocess` style flags (see `src/vs/platform/environment/node/argv.ts`); alternatively wrap `Module._load` via a preload. Approach not yet tried.
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
- Scratch outputs of the traces were written to a temporary scratchpad and are **not** preserved; the committed copies are in `docs98/inventory/data/`.

## Open questions for the owner
- Which Windows machine/VM will be used for real testing (Win 7 first)?
- Is performance of a small JS engine acceptable if it makes VS Code slow on old CPUs? (The owner already noted CPU limits for the Claude Code extension.)
- Should webviews be treated as optional on the oldest targets, or a hard requirement?
