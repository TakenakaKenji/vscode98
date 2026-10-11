# Inventory — Electron APIs

Taken at `32bbe1b8`. Source: `scripts/scan_imports.py`, `scripts/scan_electron.py`. Unit: files importing the named symbol from `'electron'`.

## Where Electron is imported

| Layer | Files |
|---|---|
| `electron-main` | 47 |
| `electron-browser` | 3 |
| `electron-utility` | 1 |
| `node` (type/dynamic) | 1 |
| **Total** | **52** |

No `common/` or general `browser/` code imports Electron.

## APIs used (value symbols, by file count)

| API | Files | Replacement duty in vscode98 host |
|---|---|---|
| `BrowserWindow` | 16 | Native top-level window creation, show/hide/focus, bounds, fullscreen, title bar, state |
| `app` | 15 | Lifecycle, paths (`userData`, etc.), single-instance lock, quit, `open-file`/`open-url` events |
| `webContents` / `WebContents` | 10+3 | Per-window control: load URL, zoom, devtools, find, print, navigation events |
| `Menu` / `MenuItem` | 4 / 3 | Native menu bar and context menus |
| `screen` | 3 | Display geometry |
| `session` | 3 | Request interception, headers, cookies, protocol handling |
| `shell` | 3 | Open external URL/file, show item in folder, trash |
| `net` | 3 | HTTP requests through Chromium's network stack |
| `powerMonitor` | 2 | Suspend/resume, idle |
| `protocol` | 2 | Custom `vscode-file:` / `vscode-webview:` schemes (how the renderer loads local files) |
| `systemPreferences` | 2 | Theme/high-contrast, accent |
| `clipboard` | 2 | Clipboard text/image/files |
| `dialog` | 1 | Native open/save/message dialogs |
| `ipcMain` / `ipcRenderer` | 1 / 2 | IPC |
| `contextBridge` | 1 | Preload API exposure (see below) |
| `utilityProcess` / `UtilityProcess` | 1 each | Spawning shared/extension/agent-host Node processes |
| `MessageChannelMain` / `MessagePortMain` | 1 / 2 | Direct process-to-process message ports |
| `safeStorage` | 1 | Encrypt secrets (OS keychain/DPAPI) |
| `Notification`, `globalShortcut`, `powerSaveBlocker`, `desktopCapturer`, `contentTracing` | 1 each | Mostly droppable or trivial |
| `BaseWindow`, `WebContentsView` | 1 each | Window composition |

Windows-only: `JumpListCategory`/`JumpListItem` (taskbar jump list, Win 7+, droppable on XP/98).

## The renderer bridge (key seam)

`src/vs/base/parts/sandbox/electron-browser/preload.ts` runs with Node/Electron access and exposes this to the page as `globalThis.vscode`:

| Exposed | Operations seen in code | Purpose |
|---|---|---|
| `ipcRenderer` | `send`, `invoke`, `on`, `once`, `removeListener` (with channel allow-listing on `vscode:` prefix) | Message the main process |
| `ipcMessagePort` | `acquire(responseChannel, nonce)` | Obtain a direct `MessagePort` to another process |
| `webFrame` | `setZoomLevel` | Zoom |
| `webUtils` | `getPathForFile` | Map dropped `File` to disk path |
| `process` | `platform`, `arch`, `type`, `versions`, `env`, `execPath`, `cwd()`, `getProcessMemoryInfo()`, `on(...)` (limited) | Minimal process info |
| `context` | `configuration()`, `resolveConfiguration()` | Window configuration passed from main |

There are about 72 distinct `vscode:`-prefixed strings in `src/vs` (mostly IPC channel names; not filtered for other uses). Implementing this bridge + the matching main-process handlers is the core of replacing Electron's main process. `preload-aux.ts` is the equivalent for auxiliary windows.

## Chromium-provided behavior that is *not* an API call (still needed)

Custom URL schemes for loading resources, CSP/Trusted Types enforcement, sandboxing and process isolation, IME, drag-and-drop, native scrollbars, spellcheck, accessibility tree, GPU rasterization, DevTools. These come from Chromium, not from `electron` imports, so they do not appear in the table above. Whether each one is needed on old Windows must be decided case by case.

## Implications

- Re-implementing the **main process** (~29k lines in `electron-main`) is mostly a matter of re-providing ~15 well-defined APIs over Win32. This is a bounded task.
- The **preload bridge** is small, so the renderer-side seam is small.
- The unbounded part is *behavior implicit in Chromium* (see above and [dom-and-web-apis.md](dom-and-web-apis.md)).
