# Inventory — Native Modules and Bundled Binaries

Taken at `32bbe1b8` from `package.json` and `remote/package.json` plus import scans. Descriptions of what each module does come from general knowledge of these packages; whether each contains compiled code is marked **(unverified)** where not confirmed by inspecting `node_modules` (not installed in this clone).

## Compiled (N-API / node-gyp) modules

| Module | In | Purpose | Windows relevance | Port notes |
|---|---|---|---|---|
| `node-pty` ^1.2.0-beta.15 | app, remote | Pseudo-terminal for integrated terminal | Uses ConPTY on Win10 1809+, winpty on older **(unverified for this version)** | Win 7/XP: needs winpty-style approach; Win 98: no pty concept, need custom console host |
| `@parcel/watcher` ^2.5.6 | app, remote | Recursive file watching | Uses `ReadDirectoryChangesW` | Win9x has `FindFirstChangeNotification` only; polling fallback is possible |
| `@vscode/sqlite3` 5.1.12-vscode | app, remote | State storage (key/value DB) | Pure C library | Portable C; builds for old Windows if toolchain allows |
| `native-keymap` ^3.3.5 | app | Keyboard layout mapping | Win32 `GetKeyboardLayout` etc. | Win9x supports the base calls; details **(unverified)** |
| `@vscode/windows-process-tree` ^0.8.0 | app, remote | Process tree for terminal/shell detection | ToolHelp / NT APIs | ToolHelp32 exists on Win9x |
| `@vscode/policy-watcher` ^1.6.0 | app | Windows Group Policy / enterprise settings | Modern Windows only | Droppable on old targets |
| `@vscode/spdlog` ^0.15.8 | app, remote | Logging | Portable C++ | |
| `@vscode/windows-registry` ^1.3.0 | app, remote | Registry reads | Win32 registry | Available on all Windows |
| `@vscode/windows-mutex` ^0.5.0 | app | Single-instance / updater mutex | Win32 mutex | Available on all Windows |
| `@vscode/native-watchdog` ^1.4.6 | app, remote | Kill orphaned processes | | Review for 9x |
| `native-is-elevated` 0.9.0 | app | Admin check | NT security API | Not applicable on 9x |
| `kerberos` 2.1.1 | app, remote | Kerberos auth (enterprise) | | Droppable |
| `windows-foreground-love` 0.6.1 (optional) | app | Focus-steal helper | | |
| `@vscode/fs-copyfile` 2.0.0 | app, remote | Native copy-on-write copy | **(unverified)** | Fallback to normal copy |
| `@vscode/deviceid` ^0.1.1 | app, remote | Telemetry device id | **(unverified)** | Droppable |
| `@vscode/sudo-prompt` 9.3.2 | app | Elevated save | JS, shells out | Droppable |

## WebAssembly modules (need a WASM runtime or native replacement)

| Module | Purpose | Importance |
|---|---|---|
| `vscode-oniguruma` 1.7.0 | Oniguruma regex engine compiled to WASM, used by `vscode-textmate` | **Critical**: all TextMate syntax highlighting |
| `@vscode/tree-sitter-wasm` ^0.3.1 | Tree-sitter parsers | High (newer syntax features) |
| `libsodium-wrappers` ^0.8.4 | Crypto | Only used by certain features **(unverified)** |
| `@vscode/vscode-languagedetection` | ML language detection (TensorFlow.js-like) | Low; droppable |

## Bundled executables

| Binary | Purpose | Notes |
|---|---|---|
| `@vscode/ripgrep-universal` | Fast text search (`ripgrep`, Rust) | Rust no longer targets XP/9x; need an old ripgrep build, or write replacement search |
| `cli/` (Rust, `code` CLI) | `code` command, tunnels | Rust (`tokio`, `reqwest`, `hyper`) — not buildable for XP/9x; likely dropped or rewritten |
| `build/win32/inno_updater.exe` | Updater | Windows installer tech; needs replacement for old OS |
| `build/win32/explorer-dll-fetcher.ts` | Explorer integration | Droppable |

## Pure JS dependencies of note (portable if the JS engine is capable)

`vscode-textmate`, `jschardet`, `@vscode/iconv-lite-umd`, `@xterm/xterm` + addons (terminal emulator; webgl addon optional), `katex`, `yauzl`/`yazl`/`tar` (archives), `minimist`, `ws` (WebSocket), `zod`, `undici`, `ssh2` (pure JS with optional native crypto), `@vscode/proxy-agent`, `@vscode/iconv-lite-umd`.

## AI / agent dependencies (probably out of scope for old Windows)

`@github/copilot-sdk`, `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@vscode/copilot-api`, `@modelcontextprotocol/sdk`, `foundry-local-sdk`, `playwright-core`, `chrome-remote-interface`, `@devcontainers/cli`, `@microsoft/dev-tunnels-*`. These need modern TLS, modern Node, and cloud services. See proposal D-008 in [../05-decisions.md](../05-decisions.md).

## Verified after `npm ci` on the dev machine (Linux x64)

- Compiled `.node` binaries exist for `node-pty` (`build/Release/pty.node`), `@vscode/sqlite3` (`vscode-sqlite3.node`), and `@parcel/watcher` (`watcher.node`). They loaded and worked at runtime in the scenario trace (terminal ran real bash; workspace watching/search ran).
- `@vscode/ripgrep-universal` ships prebuilt binaries for darwin, linux (several arches), and **win32-x64, win32-ia32, win32-arm64** only. There is no build for Windows XP/9x, so a custom ripgrep (or replacement search) will be needed for the old targets.

## Still to verify

- Which modules truly contain `.node` binaries vs. pure JS.
- Which ship prebuilt Windows binaries and which compile at install (`build/npm/postinstall.ts` uses a bundled `node-gyp`).
- Minimum Windows API level each native module requires.
