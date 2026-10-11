# 04 — Roadmap

Status values: `not started`, `in progress`, `done`, `blocked`.

## Phase 0 — Setup and inventory — `in progress`

| Item | Status |
|---|---|
| Fork cloned, remotes configured | done |
| Project docs (`docs98/`) | done |
| Inventory pass 1 (static scans of `src/vs`): DOM / CSS / Web APIs | done → [inventory/dom-and-web-apis.md](inventory/dom-and-web-apis.md) |
| Inventory pass 1: Node built-ins | done → [inventory/node-apis.md](inventory/node-apis.md) |
| Inventory pass 1: Electron APIs | done → [inventory/electron-apis.md](inventory/electron-apis.md) |
| Inventory pass 1: native modules | done (needs `npm ci` to verify) → [inventory/native-modules.md](inventory/native-modules.md) |
| Inventory pass 1: JS language level | done (needs a real build to verify) → [inventory/js-language-level.md](inventory/js-language-level.md) |
| Inventory pass 2: built-in `extensions/`, `build/`, finer CSS inventory | not started (see [inventory/README.md](inventory/README.md)) |
| Inventory pass 3: runtime tracing of a real VS Code session | in progress: renderer startup + scripted scenarios done → [runtime-trace.md](inventory/runtime-trace.md), [runtime-trace-scenarios.md](inventory/runtime-trace-scenarios.md); markdown webview measured → [runtime-trace-webview.md](inventory/runtime-trace-webview.md); main + 5 utility processes measured → [runtime-trace-processes.md](inventory/runtime-trace-processes.md); language-server children, other webviews, production bundle pending |
| Baseline: build stock VS Code on this machine | in progress: `npm ci`, transpile, extensions compile, Electron download, headless launch done; production bundle/memory baseline pending → [inventory/baseline-build.md](inventory/baseline-build.md) |
| Deepen git history / fetch upstream tags | not started |
| Windows build/test environment (VM or machine) | not started |

**Exit criterion:** we can state, with data, the size of the DOM/CSS/Node/Electron surface the host must provide.

## Phase 1 — Feasibility spikes — `not started`

Small experiments to de-risk the three components before committing.

| Spike | Question |
|---|---|
| JS engine | Can QuickJS(-ng) (or another engine) load the compiled workbench bundle? How slow? What ES features are missing? |
| Rendering | Can a minimal DOM + flexbox + GDI renderer draw a simple Monaco editor view? |
| Node shim | Can the extension host boot on a minimal `fs`/`child_process`/`net` shim? |
| Build | Can we produce a downleveled, single-bundle build of the workbench? |

**Exit criterion:** decisions D-004 (JS engine), D-005 (render strategy), D-006 (process/IPC model) recorded in [05-decisions.md](05-decisions.md).

## Phase 2 — Win 7 host — `not started`

Implement components A, B, C to the point where VS Code starts without Electron on Windows 7 and meets the Win 7 success criteria in [01-goal-and-scope.md](01-goal-and-scope.md).

## Phase 3 — Windows XP — `not started`

Retarget toolchain and APIs to XP; replace anything Vista+; document gaps.

## Phase 4 — Windows 98 — `not started`

Retarget to the Win9x API set (unicows, no IOCP, etc.); fill in the feasibility table in [03-targets-and-limits.md](03-targets-and-limits.md) with hard-limit evidence.

## Cross-cutting tracks (run alongside phases)

- Upstream sync strategy (how often to merge `upstream/main`, or pin a base version).
- Performance budget (startup time, memory) per target.
- Build/packaging/installer per target.
- Test strategy (unit tests of shims, smoke tests on real/VM Windows).
