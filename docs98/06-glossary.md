# 06 — Glossary

| Term | Meaning |
|---|---|
| **Electron** | Framework bundling Chromium + Node.js + native OS APIs into one app runtime. What VS Code runs on today. |
| **Chromium** | The browser engine inside Electron. Renders DOM/CSS, runs JS (V8). |
| **V8** | Google's JS engine, used by Chromium and Node. |
| **Node.js** | JS runtime for non-browser work (files, processes, network). |
| **Main process** | Electron's Node process that creates windows and handles OS integration (`src/vs/code/electron-main`). |
| **Renderer** | A Chromium process rendering a window's UI. In VS Code, the workbench. |
| **Utility process** | Electron-managed Node process for background work. |
| **Shared process** | VS Code background process shared by windows (extensions management, telemetry, etc.). |
| **Extension host** | Separate process that runs extensions and exposes the `vscode` API to them. |
| **Workbench** | VS Code's application UI and features (`src/vs/workbench`). |
| **Monaco** | The editor component (`src/vs/editor`), usable standalone in web pages. |
| **IPC** | Inter-process communication (messages between the processes above). |
| **LSP** | Language Server Protocol: external process that provides language features to an editor. |
| **DAP** | Debug Adapter Protocol. |
| **ConPTY** | Windows pseudo-console API (Windows 10 1809+) used for the terminal. |
| **winpty** | Older library emulating a pty on Windows before ConPTY. |
| **Native module** | npm package containing compiled C/C++ code (`.node` file), tied to a Node/Electron ABI. |
| **ABI** | Binary interface a native module is compiled against; must match the runtime. |
| **Webview** | Isolated HTML page embedded in the workbench by extensions (e.g. markdown preview). |
| **Win9x** | Windows 95/98/98SE/ME family (DOS-based kernel, not NT). |
| **NT** | Windows NT family kernel (NT, 2000, XP, Vista, 7, ...). |
| **unicows / MSLU** | Microsoft Layer for Unicode; gives Win9x some Unicode `W` APIs. |
| **KernelEx** | Community compatibility layer adding newer APIs to Win9x. **(unverified details)** |
| **GDI** | Windows graphics API available back to Win 3.x; the likely renderer for old targets. |
| **IOCP** | I/O Completion Ports; NT-only async I/O primitive. |
