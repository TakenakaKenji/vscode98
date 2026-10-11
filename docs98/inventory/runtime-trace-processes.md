# Inventory — Runtime Trace: Node and Electron APIs per Process

The process-side counterpart of the renderer traces ([runtime-trace.md](runtime-trace.md), [runtime-trace-scenarios.md](runtime-trace-scenarios.md)). It answers: **what does a Node/Electron-free host have to provide for VS Code's non-UI processes?**

- **Taken at:** `32bbe1b8` (1.142.0), Electron 43.7.7 (Node 24.21.0), Linux, headless, dev mode.
- **Scenario:** the same 10-step scripted session as the scenario trace (typing, quick open/scroll/find, search, terminal, settings, markdown preview, diff, explorer), about 2.5 minutes, with the hook active in every process it could reach.
- **Tools:** [scripts/node_hook.cjs](scripts/node_hook.cjs) (per-process tracer), [scripts/run_scenarios.sh](scripts/run_scenarios.sh) with `PROC_TRACE=1`, [scripts/analyze_proc_trace.py](scripts/analyze_proc_trace.py).
- **Data:** [data/process-trace-summary.json](data/process-trace-summary.json). The raw per-process JSON is **not** committed (it contains the full list of environment variable *names* from the dev machine; the summary keeps only VS Code/Electron/standard names and reports the rest as counts).
- **Re-run:** `PROC_TRACE=1 bash docs98/inventory/scripts/run_scenarios.sh <workdir> 9333`, then `python3 -I docs98/inventory/scripts/analyze_proc_trace.py <workdir> out.json`.

## Method, and how the hook reaches each process

| Process kind | How the hook is injected | Reached? |
|---|---|---|
| Electron main | `-r node_hook.cjs` on the command line. `NODE_OPTIONS=--require` is **rejected** in the main process ("Most NODE_OPTIONs are not supported in packaged apps") even though the fuse is enabled | yes |
| Utility processes (shared, extension host, pty host, file watcher, agent host) | One import prepended to the *generated* `out/bootstrap-fork.js` (all of them start there); restored afterwards. `execArgv: ['--require=…']` did **not** work for utility processes | yes (5) |
| Children of the extension host (`tsserver`, JSON language server, …) | `NODE_OPTIONS` inherited through the environment | **no**: none reported (see gaps) |
| Renderer | not Node (sandboxed); covered by the renderer traces | n/a |

What the hook records (never values, never arguments): call counts for Node built-in functions and class methods; `process.*` members; environment variable **names**; native addon loads (`process.dlopen`); for Electron main, API methods, event names, and `ipcMain` channels. For each key it samples the stack of the **first 5 calls** and marks it "app-called" if the immediate caller is not Node's own `node:` code. All counts below are **app-called only**; Node-internal self-calls (module loader, `readFileSync` → `openSync`, etc.) are excluded (often far larger than the app's own use: e.g. 441,359 internal `stream` calls vs 5 app calls, 68,832 internal `worker_threads` calls vs 2, 32,133 internal `fs` calls vs ~9,500).

## Processes observed

| Process | Entry point | Role |
|---|---|---|
| main (`browser`) | `out/main.js` → `vs/code/electron-main` | windows, menus, protocols, IPC server, lifecycle |
| shared process | `…/sharedProcess/sharedProcessMain` | extension management, telemetry, storage |
| extension host | `vs/workbench/api/node/extensionHostProcess` | runs extensions, `vscode` API |
| pty host | `vs/platform/terminal/node/ptyHostMain` | `node-pty`, terminals |
| file watcher | `vs/platform/files/node/watcher/watcherMain` | `@parcel/watcher` |
| agent host | `vs/platform/agentHost/node/agentHostMain` | AI agents (scoped out by D-008) |

**Native addons loaded:** main `keymapping.node` (native-keymap), `spdlog.node`, `vscode-sqlite3.node`; pty host `pty.node`, `spdlog.node`; watcher `watcher.node`; extension host `spdlog.node`; agent host `bufferutil.node`, `spdlog.node`, `vscode-sqlite3.node`; shared process none.

## Node built-ins called by application code (union of all processes)

| Module | Distinct functions | What was called |
|---|---|---|
| `original-fs.promises` | 13 | `readdir`, `lstat`, `stat`, `mkdir`, `writeFile`, `rm`, `rename`, `readFile`, `chmod`, `access`, `open`, `realpath`, `mkdtemp` |
| `fs.promises` | 9 | `lstat`, `stat`, `readdir`, `readFile`, `open`, `realpath`, `access`, `rename`, `unlink` |
| `fs` (+ `Stats`/`Dirent` methods) | 20 | `existsSync`, `readFile`, `open`, `close`, `read`, `write`, `fdatasync`, `exists`, `writeFileSync`, `accessSync`, `writeFile`, `lstat`, `readdirSync`, `mkdirSync`; `Stats#.isFile/isDirectory/isSymbolicLink`, `Dirent#.isFile/isDirectory/isSymbolicLink` |
| `original-fs` | 11 | `open`, `close`, `realpathSync`, **`watch`, `watchFile`**, `readFileSync`, `write`, `fdatasync`, `existsSync`, `writeFile`, `unlinkSync` |
| `net` | 16 | `createServer`, `createConnection`, `Server#.listen/address`, `Socket#.connect/unref`, stream methods (`write`, `end`, `setEncoding`, `on(data/close/error/exit)`, `removeListener`, `off`) |
| `child_process` | 12 | `spawn`, `exec`, `fork`, `ChildProcess#.kill` |
| `os` | 14 | `homedir`, `platform`, `tmpdir`, `release`, `arch`, `totalmem`, `networkInterfaces`, `hostname`, `type`, `cpus`, `freemem`, `loadavg`, `availableParallelism`, `version` |
| `crypto` | 4 | `createHash`, `getHashes`, `randomBytes`, `randomUUID` |
| `http` | 3 | `createServer`, `Server#.close`, `Server#.closeAllConnections` (agent host + extension host) |
| `readline` | 2 | `createInterface`, `Interface#.close` |
| `tty` | 1 | `isatty` |
| `module` | 2 | `createRequire`, `registerHooks` |
| `util` / `url` | 4 / 4 | `promisify`, `debuglog`, `deprecate`, `inherits` / `pathToFileURL`, `fileURLToPath`, `parse`, `format` |
| `worker_threads` | 1 | `markAsUncloneable` |
| `stream` | 2 | `EventEmitter.get/setMaxListeners` |

**Not called by application code in this session:** `https`, `tls`, `http2`, `dgram`, `dns` (beyond Node internals), `zlib`, `vm`, `v8`, `inspector`, `cluster`, `perf_hooks`, `querystring`, `string_decoder`, `async_hooks`, `fs.createReadStream/createWriteStream`, `worker_threads.Worker`. (Absence means "not seen in these scenarios", not "never used": no network was needed offline, no archives were extracted, and so on.)

### Observations
- **File access is overwhelmingly `original-fs`/`fs` promises plus callbacks**; there is no stream-based file I/O. `fs.watch`/`watchFile` are used, plus the native `@parcel/watcher` addon in the watcher process.
- **`child_process` launches real programs:** `rg` (ripgrep, from main and extension host), `git` (extension host), `fork` of `tsserver.js`, the JSON language server, and an extension-host worker; pty host runs `ps`, `which`, and a CPU-usage shell script via `exec`. The agent host spawned `claude`, `codex` and a Copilot runtime (out of scope, D-008).
- **`net` is used for IPC** (named-pipe/unix-socket servers `createServer`/`createConnection`) and for socket streams in the agent host, extension host and pty host.
- **`http.createServer` appears in the agent host and the extension host.** What the extension host uses it for was not determined.
- **The Node API surface the app itself calls is small:** 118 distinct functions (counting class methods and event-name variants separately) across 16 module entries, i.e. ~13 real modules. The big costs are semantic (correct `child_process` pipes, `net` named pipes, `fs.watch`) rather than breadth.

## `process.*` members

Used: `platform`, `arch`, `versions`, `version`, `release`, `argv`, `execArgv`, `execPath`, `pid`, `ppid`, `title`, `config`, `cwd()`, `kill()`, `nextTick()`, `getuid()`, `getgid()`, `emitWarning()`, `dlopen()` (native addons), and events `exit`, `uncaughtException`, `unhandledRejection`, `rejectionHandled`, `warning`, `SIGPIPE`. `process.env` is also enumerated (`Object.keys`) in main, agent host, extension host and pty host.

## Environment

- **237 distinct variable names were read** across the processes; **11 were set** (8 VS Code/Electron ones kept in the summary: `VSCODE_CODE_CACHE_PATH`, `VSCODE_CWD`, `VSCODE_IPC_HOOK`, `VSCODE_L10N_BUNDLE_LOCATION`, `VSCODE_NLS_CONFIG`, `VSCODE_NODE_COMPILE_CACHE_ROOT`, `VSCODE_PID`, `ELECTRON_RUN_AS_NODE`).
- The summary JSON keeps the **80** that are VS Code/Electron/standard (e.g. `VSCODE_ESM_ENTRYPOINT`, `VSCODE_PARENT_PID`, `VSCODE_IPC_HOOK`, `VSCODE_NLS_CONFIG`, `HOME`, `PATH`, `APPDATA`, `PATHEXT`, `PROCESSOR_ARCHITECTURE`, proxy variables, `XDG_*`). The other 157 are machine-specific (desktop environment, shell, other tools) and are not recorded.
- On Windows the equivalents (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `COMSPEC`, …) will matter; they were not observable on this Linux run.

## Electron APIs called in the main process

| Group | Methods / events seen |
|---|---|
| `app` | 19 events: `ready`, `will-finish-launching`, `before-quit`, `will-quit`, `window-all-closed`, `activate`, `open-file`, `open-url`, `login`, `browser-window-created/focus/blur`, `web-contents-created`, `new-window-for-tab`, `child-process-gone`, `network-process-gone/launched`, `gpu-info-update`, `accessibility-support-changed`; 7 methods: `getGPUFeatureStatus`, `setVersion`, `setDesktopName`, `setAppPath`, `setPath`, `getPreferredSystemLanguages`, `getLocale` |
| `BaseWindow` / `BrowserWindow` instances | 14 methods: `setTitleBarOverlay`, `isDestroyed`, `isVisible`, `isFullScreen`, `isSimpleFullScreen`, `isMaximized`, `isAlwaysOnTop`, `getSize`, `getMinimumSize`, `getNativeWindowHandle`, `setBackgroundColor`, `setMenuBarVisibility`, `setTitle`, `loadURL`; 11 events: `close`, `closed`, `focus`, `maximize`, `unmaximize`, `enter/leave-full-screen`, `always-on-top-changed`, `system-context-menu`, `responsive`, `unresponsive` |
| `BrowserWindow` statics | `getAllWindows`, `getFocusedWindow`, `fromWebContents` |
| `powerMonitor` | events `suspend`, `resume`, `on-ac`, `on-battery`, `thermal-state-change`, `speed-limit-change`, `shutdown`, `lock-screen`, `unlock-screen` |
| `protocol` | `registerSchemesAsPrivileged`, `handle('vscode-webview')`, `handle('vscode-remote-resource')` |
| `net` | `fetch` (used to serve every renderer file through the `vscode-file://` handler in `ProtocolMainService.createFileResponse`) |
| `Menu` | `setApplicationMenu`, `getApplicationMenu` |
| `clipboard` | `writeText`, `readText` |
| `crashReporter`, `safeStorage`, `nativeTheme` | `start`; `isEncryptionAvailable`; `on('updated')` |

**75 distinct entries in total (35 methods + 40 event names).** **Not seen in these scenarios:** `dialog`, `shell`, `screen`, `globalShortcut`, `Notification`, `systemPreferences`, `powerSaveBlocker`, `desktopCapturer`, `contentTracing`, tray/touch-bar APIs: the synthetic session never opened a native dialog or opened a link externally. `webContents` and `session` *instance* methods (the IPC `send`, `postMessage`, `setZoomLevel`, request interception) were **not captured** (hook gap, below), so that part of the Electron surface is unmeasured.

## IPC (main process, `ipcMain`)

17 channels registered, 8 received during the session:

`vscode:message` (**2,558 received**, the multiplexed channel that carries almost all renderer ↔ main traffic), plus one-shot control channels: `vscode:hello`, `vscode:fetchShellEnv`, `vscode:agentHostOTelPolicy`, `vscode:createSharedProcessChannelConnection`, `vscode:createPtyHostMessageChannel`, `vscode:createAgentHostMessageChannel`, and one `vscode:<uuid>` channel (purpose not determined; probably a per-window handshake).

Registered but not exercised: `vscode:contextmenu`, `vscode:disconnect`, `vscode:createSharedProcessRawConnection`, `vscode:notifyZoomLevel`, `vscode:openDevTools`, `vscode:toggleDevTools`, `vscode:registerAuxiliaryWindow`, `vscode:reloadWindow`, `vscode:restartAgentHost`.

So the preload bridge (`ipcRenderer.send/invoke/on` + `ipcMessagePort.acquire`) really amounts to **one multiplexed message channel plus ~3 message-port handoffs** (shared process, pty host, agent host). Everything else (services such as files, dialogs, native host) is routed *inside* `vscode:message` by VS Code's own channel layer, which is portable TypeScript.

## What this says about the host (updates to architecture notes)

1. **Node shim size:** 118 distinct functions across ~13 modules for the whole app, much smaller than the full Node API. Priorities by risk: `child_process` (spawn/exec/fork with pipes and kill), `net` (named pipes/sockets, `Server#.listen`), `fs` (`watch`, `open/read/write/fdatasync`, promise APIs, symlink/stat info), `os`, `crypto.createHash/randomBytes`.
2. **Electron replacement is bounded:** 75 distinct API methods/events plus one multiplexed IPC channel and three `MessagePort` handoffs. A native launcher implementing windows, a menu, clipboard, power events, two custom protocols (`vscode-webview`, `vscode-remote-resource`), the `vscode-file` file protocol and message ports covers what was exercised. Dialogs, shell open, and screen info still need implementing (they are used by VS Code, just not in this session).
3. **The `vscode-file://` protocol is the renderer's file loader.** In dev mode it served thousands of module files via `net.fetch`; in a bundled build it serves few. The host's resource loader must cover this scheme.
4. **Native addons to port per OS:** `native-keymap` (keyboard layout), `spdlog`, `@vscode/sqlite3`, `@parcel/watcher`, `node-pty` (+ `bufferutil` for the agent host only). Of these, `pty` and `watcher` are the OS-specific hard ones for XP/98.
5. **External programs the app launches:** `rg` and `git` are the hard external dependencies for core features (search, source control); `tsserver` is Node-based, so it only needs the Node shim; terminals need a shell. Their availability on Win 7/XP/98 is a separate question (see [native-modules.md](native-modules.md): ripgrep has no XP/9x build).
6. **Process model:** VS Code runs 5 helper processes (+ renderer) on top of main. On the oldest targets, merging some of them into fewer processes or threads is an open design question (D-006).

## Gaps and caveats

- **Language servers and other extension-host children were not traced.** `tsserver`, the JSON server and the worker were forked (`fork(tsserver.js)` etc. appear in the extension host's counts) but did not report, so `NODE_OPTIONS` did not reach them. The Node surface they need is therefore **not included** above. Fix idea: have the hook wrap `child_process.fork/spawn` to add `--require` for Node-based children.
- **`webContents`/`session` instance methods are unmeasured** (the hook patches prototypes, but those instances' methods did not show up; likely own properties of instances).
- **Synthetic scenarios, dev mode, Linux, 2.5 minutes.** Features not exercised (git, extensions install, debugging, notebooks, remote, settings sync, update, file dialogs, drag-and-drop, many menu actions) will add calls. Windows-specific code paths (registry, `windows-process-tree`, `policy-watcher`, ConPTY) did not run.
- **App-called detection is a heuristic** (immediate caller of each key's first 5 calls). It can misclassify a key that is first called internally and later by the app. Counts are for ranking, not exact.
- **Dumps were taken every 1.5 s and at process exit**; the processes were killed with SIGTERM, so the last up-to-1.5 s of each process is missing (`final: false`).
- **The hook itself is intrusive** (wraps functions, proxies `process.env`). Behavior was unchanged in all runs (every scenario check passed), but a first version broke `Object.assign(process.env, …)` until fixed (see git history).
- `original-fs` and `fs` appear as separate modules here because Electron provides both; they are the same API for the shim's purposes.
- Agent-host numbers are included for completeness but that feature is out of scope for old Windows (D-008).

## Next

- [ ] Trace language-server children (wrap `child_process.fork/spawn`), then re-measure the extension-host-side Node surface.
- [ ] Capture `webContents`/`session` instance methods (patch instances on `web-contents-created`).
- [ ] Windows run of the same scenarios (registry, ConPTY, `windows-process-tree`, `policy-watcher` paths), once a Windows test machine exists.
- [ ] More scenarios (git, extension install, debugging, dialogs).
