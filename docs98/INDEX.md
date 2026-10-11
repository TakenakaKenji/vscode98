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
| [inventory/runtime-trace-processes.md](inventory/runtime-trace-processes.md) | **Measured** Node + Electron API usage of the main process and 5 utility processes (118 Node functions, 75 Electron methods/events, IPC channels, native addons, env, spawned programs) |
| `inventory/data/` | Raw JSON from traces |
| `inventory/scripts/` | The scan scripts that produced the numbers (`scan_imports.py`, `scan_electron.py`, `scan_web_and_lang.sh`, `trace_renderer.mjs`, `trace_scenarios.mjs` + `run_scenarios.sh`, `trace_webview.mjs`, process hook `node_hook.cjs` (+ `node_hook_esm.mjs`, `analyze_proc_trace.py`), shared `trace_common.mjs`/`cdp_input.mjs`) |

## Key facts to remember (quick reference)

- Electron is imported in only ~52 files (47 in `electron-main`); the renderer reaches it through one preload bridge (`src/vs/base/parts/sandbox/electron-browser/preload.ts`).
- Only 25 Node built-ins are imported in `src/vs`; hardest are `child_process`, `net`/`http`/`https`/`tls`.
- 471 CSS files (~92k lines); flexbox in 287, custom properties in 408, grid in 39.
- WebAssembly (`vscode-oniguruma`, tree-sitter) is required for syntax highlighting.
- **Runtime trace (measured):** startup uses only ~180 distinct DOM/Web members and 227 distinct standard CSS properties; layout is block/inline/flex/absolute only (no grid/fixed/sticky live); editor input is a `<textarea>`; renderer heap ~123 MB.
- **Scenario trace (measured):** startup + 9 features = 312 distinct instrumented members; editor typing needs full legacy keyboard events; terminal uses `OffscreenCanvas` + Canvas 2D (no WebGL); webviews are an iframe-in-iframe over a `vscode-webview:` scheme + service worker (content measured in `runtime-trace-webview.md`: table/list/inline layout, 144 CSS properties, KaTeX web fonts).
- **Process-side trace (measured):** the whole app calls only 118 distinct Node functions (~13 modules) and 75 Electron methods/events; renderer↔main IPC is one multiplexed `vscode:message` channel + ~3 MessagePort handoffs; programs launched: `rg`, `git`, `tsserver`, shells. Language-server children not yet traced.
- Build targets are ES2024 (no downleveling today).
- Open proposals: D-003 (custom host), D-004/5/6 (engine, render, IPC), D-008 (scope out AI/cloud features) in [05-decisions.md](05-decisions.md).

## Conventions

- Docs are Markdown, one topic per file, numbered for the core set.
- Measured claims (counts, file lists) say which commit they were taken at and how to reproduce them.
- Unverified claims are marked **(unverified)**.
- Status values: `not started`, `in progress`, `done`, `blocked`.
- Upstream VS Code files are not edited for docs; everything project-specific lives here or in clearly new files.
