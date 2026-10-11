# 01 — Goal and Scope

## End goal

A **standalone application** providing the **full VS Code feature set**, with **no Electron dependency**, that can be used to work on projects on old Windows machines.

Target OS ladder, worked in this order (see [03-targets-and-limits.md](03-targets-and-limits.md)):

1. Windows 7
2. Windows XP
3. Windows 98 (the extreme end; may not be fully reachable)

## Guiding principle: "physically possible", not "feasible"

The owner has explicitly said the bar is what is **physically possible** on the target hardware and OS, not what is convenient or commercially feasible. This is a deliberately off-the-wall, long-term project.

Consequences:
- Do not drop a feature just because it is hard; drop it only when the OS/hardware or its external dependencies make it impossible.
- When something is impossible, document exactly why (in `03-targets-and-limits.md`) and what the closest achievable substitute is.
- Effort estimates are not a reason to cut scope, but they do drive ordering.

## What "full feature set" means

Features to preserve, with the main dependency that makes each hard:

| Feature | Depends on |
|---|---|
| Monaco editor (editing, highlighting, folding, multi-cursor, diff) | DOM/CSS rendering, JS engine |
| Workbench UI (sidebar, panels, tabs, menus, settings, themes) | DOM/CSS layout |
| File explorer, search, file watching | Node `fs`, ripgrep, native watcher |
| Integrated terminal | pty (ConPTY on modern Windows), xterm.js (DOM/canvas) |
| Extensions (JS, `vscode` API) | Extension host process, Node API shim |
| Language servers / debuggers (external tools) | Whether those tools can run on the target OS |
| Git integration | A `git` binary that runs on the target OS |
| Webviews (markdown preview, extension UIs) | A real HTML engine |
| Remote development (SSH, WSL, containers) | Node server, networking/TLS |
| Settings sync, auth, Copilot | Modern TLS/network, online services |
| Auto-update, installer | Installer tech that runs on target OS |

## Scope boundaries

**In scope**
- Replacing Electron's roles (windowing, rendering, Node runtime, IPC) with a custom host.
- Making the existing VS Code TypeScript run as unchanged as possible on that host.
- Porting/rebuilding native modules for each target OS.
- Build and packaging for each target OS.

**Out of scope (for now)**
- Rewriting the workbench in a native UI toolkit (rejected, see [05-decisions.md](05-decisions.md) D-003).
- Cloud/online-only features if the target OS cannot do modern TLS (revisit at XP/98 stages).
- Keeping parity with every future upstream release automatically.

## Success criteria per stage

| Stage | Done when |
|---|---|
| Win 7 | The app starts without Electron, opens a folder, edits and saves files, runs the terminal, loads at least the built-in extensions. |
| XP | Same, on XP SP3, with documented feature gaps. |
| 98 | Editor + file explorer + search + themes + pure-JS extensions work; every gap is documented as a hard OS limit. |
