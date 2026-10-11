# 02 — Architecture

## How VS Code works today (with Electron)

VS Code is a web application (TypeScript compiled to JS, DOM + CSS UI) running in a bundled Chromium, with Node.js processes acting as a local backend.

```
 Electron main process (Node + Electron native APIs)      src/vs/code/electron-main
   ├─ creates native windows, menus, dialogs, tray, updater
   │
   ├─ Renderer / window (Chromium sandbox)                src/vs/code/electron-browser
   │     workbench + Monaco: DOM, CSS, canvas, workers    src/vs/workbench, src/vs/editor
   │
   ├─ Shared process / utility processes (Node)           src/vs/code/electron-utility
   │
   └─ Extension host (separate Node process)
         runs extensions, language-server clients
         child processes: git, language servers, debuggers, pty, ripgrep

 Remote server (standalone Node, for SSH/WSL/containers)  src/vs/server/node
```

### What Electron provides

1. **Chromium**: renders the UI (DOM, CSS, canvas, workers, observers, fonts, IME, accessibility).
2. **Node.js**: filesystem, processes, networking, streams, workers.
3. **Native shell integration**: windows, menus, dialogs, tray, clipboard, protocol handlers, auto-update, crash reporting.
4. **IPC and sandboxing** between processes.

### Native modules (compiled C/C++)

`node-pty`, `@parcel/watcher`, `@vscode/sqlite3`, `native-keymap`, `@vscode/windows-process-tree`, `@vscode/policy-watcher`, `@vscode/spdlog`, `@vscode/windows-registry`, `@vscode/windows-mutex`. Details in [inventory/native-modules.md](inventory/native-modules.md).

## Target architecture (Electron-free "vscode98 host")

Replace Electron with a purpose-built host that supplies the same environment, so the real workbench code runs mostly unchanged.

```
 vscode98 launcher (native, small)                        replaces electron-main
   ├─ Win32 windows, menus, dialogs, clipboard
   ├─ owns the JS engine(s) and process management
   │
   ├─ UI runtime                                          replaces Chromium
   │     JS engine  +  minimal DOM  +  CSS layout  +  GDI/canvas rendering
   │
   ├─ Node-compatible runtime                             replaces Node.js
   │     JS engine  +  shim of fs / child_process / net / os / path / streams / worker_threads
   │
   └─ Native modules rebuilt per target OS
```

### Three components to build

| # | Component | Replaces | Notes |
|---|---|---|---|
| A | **JS engine** | V8 | Candidate: QuickJS(-ng). Must be buildable for each target OS. Slower than V8; performance is a risk. |
| B | **DOM / CSS / render layer** | Chromium | Implement only the subset VS Code uses (determined by [inventory/dom-and-web-apis.md](inventory/dom-and-web-apis.md)). Draw with GDI (works back to Win 98). |
| C | **Node API shim + IPC** | Node.js, Electron IPC | Implement the used subset of Node built-ins over Win32; reimplement Electron main-process duties natively. |

### Open design questions

- One engine instance per process, or one engine with multiple isolates? (extension host must be isolated from UI)
- How are workers (`Worker`, `MessageChannel`) implemented? (threads vs processes)
- How much of CSS must the layout engine support (flexbox, grid, custom properties, calc, transforms)?
- Text rendering: GDI text vs custom glyph rendering; Unicode handling on Win 9x (no `W` APIs without `unicows`).
- Webviews: iframe-like isolation is required by the extension API; what engine backs them?
- Build system: how to bundle/downlevel the TS output for a weaker engine.

These are tracked in [04-roadmap.md](04-roadmap.md) and resolved in [05-decisions.md](05-decisions.md).

## Reusable vs replaced code

| Part | Approx. lines (non-test, at clone) | Plan |
|---|---|---|
| `common/` code (no DOM, no Node) | ~380k | Reuse unchanged |
| `browser/` code (DOM) | ~615k | Reuse; runs on component B |
| `node/` code | ~114k | Reuse; runs on component C |
| `electron-main/` | ~29k | Replace with native launcher |
| `electron-browser/`, `electron-sandbox/`, `electron-utility/` | small | Replace/adapt |

(Counts are rough; produced by line-counting `.ts` files in folders by that name. See [inventory/README.md](inventory/README.md).)
