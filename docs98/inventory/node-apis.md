# Inventory — Node.js APIs

Taken at `32bbe1b8`. Source: `scripts/scan_imports.py`. Unit: files in `src/vs` (non-test) importing the module. "Layer" is the nearest enclosing folder named `common`/`browser`/`node`/`electron-*`.

## Built-in modules imported

| Module | Files | By layer | Role in VS Code | Win32 shim difficulty |
|---|---|---|---|---|
| `fs` | 68 | node 58, electron-main 7, utility 2 | File access everywhere | Medium (large API; many sync + callback variants) |
| `os` | 54 | node 46, main 7 | Platform/home/tmp/hostname/cpus | Easy |
| `child_process` | 42 | node 39, main 3 | Spawn git, language servers, ripgrep, shells, `fork` for extension host | **Hard** (pipes, IPC channel, exit codes, signals; weakest on Win9x) |
| `crypto` | 30 | node 28, main 2 | Hashing, random, UUIDs, signing | Medium (need hash/rand; TLS-level crypto is separate) |
| `fs/promises` | 24 | node 23, main 1 | Promise file API | Same as `fs` |
| `http` | 24 | node 23 | Servers (remote), proxies, requests | Hard (sockets) |
| `net` | 15 | node 14 | Sockets, named pipes for IPC | **Hard** |
| `module` | 11 | node 10 | `require`, module loading/compile cache | Medium (tied to JS engine) |
| `stream` | 9 | node 9 | Streams | Medium (pure JS possible) |
| `url` | 9 | | URL helpers | Easy |
| `util` | 6 | | `promisify`, `inspect`, `TextDecoder`... | Easy |
| `https` | 6 | | HTTPS requests | **Hard** (TLS) |
| `string_decoder` | 4 | | | Easy |
| `zlib` | 3 | | gzip/deflate | Medium (bundle zlib) |
| `tls` | 3 | | | **Hard** |
| `events` | 3 | | `EventEmitter` | Easy |
| `dns` | 2 | | | Medium |
| `worker_threads` | 2 | | Diff compute worker (`agentHost`) | Medium |
| `perf_hooks` | 2 | | | Easy |
| `v8`, `readline`, `inspector`, `vm`, `assert`, `path` | 1 each | | Misc | Easy/Medium (`inspector`/`v8` may be droppable) |

## Node globals used without import (file counts)

| Global | Files | Notes |
|---|---|---|
| `Buffer.` | 313 | Pervasive; need a `Buffer` implementation (can be pure JS) |
| `process.(platform/env/cwd/nextTick/versions/arch/argv/memoryUsage/hrtime)` | 123 | Need a `process` object |
| `require(` | 9 | CommonJS interop |
| `setImmediate`, `__dirname`, `SharedArrayBuffer`, `Atomics` | 0 | Not used directly in `src/vs` |

## Observations

- VS Code **does not use Node's `path`** (1 import); it ships `src/vs/base/common/path.ts`. Good for portability.
- Almost all Node usage is in `node/` and `electron-main/` folders, i.e. cleanly separated from UI code. The `common/` and `browser/` layers import **no** Node built-ins directly.
- The risky areas for old Windows are `child_process`, `net`/`http`/`https`/`tls`, and anything needing OS-level async I/O. See [../03-targets-and-limits.md](../03-targets-and-limits.md).
- The extension host (separate process) runs **third-party extensions**, which use Node much more broadly than `src/vs` does. Their requirements are not captured here (see "Not yet covered" in [README.md](README.md)).

## Third-party npm imports in `src/vs` (top, by files)

`@xterm/xterm` 59, `@github/copilot-sdk` 38, `@anthropic-ai/claude-agent-sdk` 19, `@vscode/tree-sitter-wasm` 11, `@xterm/headless` 10, `ws` 7, `@modelcontextprotocol/sdk` 7, `@vscode/proxy-agent` 4, `@anthropic-ai/sdk` 4, `@vscode/copilot-api` 4, `@vscode/windows-registry` 3, `@vscode/windows-process-tree` 3, `@vscode/sqlite3` 3, `@vscode/windows-mutex` 3, `node-pty` 2, `@vscode/policy-watcher` 2, `ssh2` 1, ... Full list in the script output (`other` key).
