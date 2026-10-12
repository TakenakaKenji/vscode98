# Spike 5 — child processes, IPC, sockets and a native module loader on QuickJS

**Questions** ([CHECKPOINT](../../CHECKPOINT.md), D-004, D-006): spike 3 left four language-client extensions blocked on `child_process.fork`, and ES-module extensions/dependencies blocked on `require(esm)` and a resolver hook. Can a small native layer plus JavaScript shims on QuickJS-ng provide (a) `child_process` with an IPC channel, (b) `net`, (c) Node's module resolution for ES modules, and do the real consumers (tsserver, language servers, the git extension) then work?

- **Engine:** QuickJS-ng 0.17.0 (`9b06171`), the same stock `qjs.c` with two added lines. **Machine:** Intel Xeon @ 2.1 GHz, 4 vCPU, Linux. **Reference:** Node 24.18.0.
- **Everything here ran on Linux** (x86-64, and an x86 32-bit build on the 64-bit kernel). The native layer is POSIX-only. Nothing was built or run on Windows; the Windows section below is analysis of what would have to change, not a result.
- **Builds on:** [spike 2](../02-node-shim/README.md) (shims) and [spike 3](../03-extension-loading/README.md) (extension loading). Several of their files were extended, see the end.

## Verdict

1. **`child_process.fork()` with an IPC channel works, and the real consumers run on it.** The unmodified TypeScript language server (`tsserver.js`, started exactly like `typescript-language-features` does: `fork(..., { stdio: ['pipe','pipe','pipe','ipc'] })`, `--useNodeIpc`) answers diagnostics, completions, quick info, navtree and references with **answers identical to Node**; the JSON, CSS, HTML and Markdown language servers are forked by their real extensions and complete the LSP `initialize` handshake; the real git extension opens a repository and runs `git status`, `for-each-ref`, ... through `child_process.spawn` (SCM source control and decorations registered).
2. **29 of the 34 built-in extensions now activate** (spike 3: 24 activated, 4 language-client extensions blocked on `fork`, 1 ESM extension (`github`) failing, 5 not triggered). The remaining 5 are "not triggered by the events the harness fires" (they need an authentication or a specific file type), not failures. **No pre-bundling is needed any more**: spike 3's `ESM_OVERLAY_DIR` stayed empty.
3. **A small native layer is enough:** 374 lines of C (`proc.c`, `esm.c`) plus about 550 lines of JavaScript for `child_process`, `net`, fd streams, `readline` and the loader hooks. Streams are the npm `readable-stream` 3.6.0 bundled with esbuild (93 KB), `string_decoder` likewise.
4. **Speed is the cost, as in spike 2, not correctness.** tsserver on a 19-file project: **1.12 s on Node, 6.73 s on QuickJS-ng (6.0×)**, 8.3 s as an x86-32 build. Spawning, pipes and sockets are not the bottleneck (same speed as Node); the JavaScript running in the forked process is.
5. **Memory is smaller, not larger:** an idle forked child is 4 MB RSS on QuickJS vs 39 MB on Node; the tsserver child peaked at 200 MB (x86-64) / 125 MB (x86-32) vs 265 MB on Node.
6. **Two real surprises** (both fixed here, both matter for the design): QuickJS's event loop on **Windows cannot wait on pipes or sockets** (only stdin and worker ports), and a JavaScript `TextDecoder` made large IPC messages **60× slower than Node** until UTF-8 conversion went native. See "Findings".

## What was built

**Native, `host/` (POSIX):**

| File | Lines | What |
|---|---|---|
| `proc.c` | 243 | module `spike:proc`: `spawn` with an arbitrary fd map (stdio plus extra pipes/socketpair ends, `exec` failure reported through a CLOEXEC pipe, PATH search in the child's env, `setsid`), `pipe`, `socketpair`, `setNonblock`, TCP/unix `listen`/`accept`/`connect`/`shutdown`/`SO_ERROR`, `pollSync` (the `poll(2)` loop behind `spawnSync`/`execSync`: stdin feed, two capped outputs, timeout), and the globals `__utf8Decode`/`__utf8Encode`. Every call returns a value or a negative errno. |
| `esm.c` | 131 | installs a module **normalizer** and **loader** that call back into JS (`__esmResolve`, `__esmLoad`), a synthetic ES module around CommonJS exports (`import x, { y } from './a.cjs'`), and `__requireEsm` (synchronous `require()` of an ES module). |
| `build.sh` | | patches the stock `qjs.c` with 2 lines (call `spike_init` per context; install the loader after `main()` installs the stock one) and links `qjs-spike5`. `M32=1` for the 32-bit build. |

**JavaScript, `host/impl/` and `host/`:**

- `child_process.js`: `spawn`, `fork` (IPC), `exec`, `execFile`, `spawnSync`, `execFileSync`, `execSync`, `ChildProcess` (`stdio`, `send`, `disconnect`, `kill`, `exit`/`close`/`error`/`spawn`/`message`/`disconnect` events). Exit detection: `SIGCHLD` + `waitpid(WNOHANG)`, plus a 500 ms safety timer that also keeps the loop alive while children exist. Mirrors Node details that real code depends on: `close` waits for all stdio, stdin is destroyed on exit, unread output is resumed on exit, ENOENT is an `error` event then `close(-2)`.
- `fdstreams.js`: `Readable`/`Writable`/`Duplex` over non-blocking fds driven by `os.setReadHandler`/`setWriteHandler` (back-pressure both ways).
- `net.js`: `Socket`, `Server`, `connect`, `createServer`, `isIP*` for TCP and unix-domain sockets.
- `readline.js` (`createInterface`, `line`/`close` events; tsserver needs it), `stream__web.js` (class names only).
- `fork_main.mjs` / `proc_setup.mjs`: the "node" of the spike. `qjs-spike5 fork_main.mjs <shims> <script> [args]` runs a script as a forked child: `process.argv/execPath/kill`, stdio as fd streams, the IPC channel (`process.send`, `'message'`, `'disconnect'`), Node-like `console`. `fork()` re-launches this runner (`process.execPath` + `globalThis.__forkHostArgs`); V8-only `execArgv` such as `--max-old-space-size` are dropped.
- `esm_loader.mjs`: Node's ESM resolution (relative/absolute/`file:` URLs, bare specifiers through `node_modules` and `package.json` `exports` with the `import` conditions, `node:`/builtins mapped to the shims, `data:` URLs), the `module.registerHooks({ resolve })` chain that VS Code's extension host uses to intercept `import 'vscode'`, CommonJS/JSON interop, and `import.meta.url/filename/dirname`.
- `build_impl.mjs` + `setup.sh`: bundle `readable-stream`/`string_decoder`, copy the impl files, generate shims (`SHIM_IMPL_DIRS` is a new switch of spike 2's `gen_shims.mjs`).

## Results

### Real consumers (all on the same host binary, forked by a QuickJS parent)

| Consumer | How it was exercised | Result |
|---|---|---|
| **tsserver** (TypeScript 6.0.3) | `tests/ts_parent.cjs`: fork + `--useNodeIpc`, 19 TS files, configure, open ×19, `semanticDiagnosticsSync`, `quickinfo`, `completionInfo`, `navtree`, `references` | Same answers on Node, QuickJS x86-64 and QuickJS x86-32 (6 semantic diagnostics, 1,135 completion entries, 97 navtree children, 1 reference, identical quick info text). Times below. |
| **JSON language server** | the real `json-language-features` extension in the extension host, started by `vscode-languageclient` (`TransportKind.ipc`) | Initialize handshake completes (the client registers its language features from the server's capabilities, completion/hover/symbols/...); with a document opened, `documentSymbols` answers over the whole chain extension host → client → IPC → server → back. Also in the x86-32 build. |
| **CSS, HTML, Markdown servers** | same, real extensions | forked, handshake completes (CSS: 14 registrations). HTML server `initialize` answer is byte-length identical to Node's (688). |
| **git extension** | real `git` + `git-base` with a workspace folder and git settings | spawns `git --version`, `rev-parse`, `config`, `for-each-ref`, `status -z -uall`; `MainThreadSCM.$registerSourceControl`/`$updateGroup`/`$updateSourceControl` arrive at the (fake) renderer. |
| **net** | `tests/net_test.cjs`: 3 MB TCP echo, unix socket, refused connection, a forked QuickJS client, a **real Node.js TCP client** against the QuickJS server | all pass (echo byte-exact, `ECONNREFUSED` with Node's fields). |

tsserver timings, same script on each runtime (`data/tsserver-*.jsonl`, 3 runs each for Node/x86-64, 1 for x86-32), time from fork to the last answer:

| | Node 24 (V8 JIT) | QuickJS x86-64 | QuickJS x86-32 |
|---|---|---|---|
| total (median) | **1.12 s** | **6.73 s** (6.0×) | 8.32 s (7.4×) |
| of which opening the 19 files (build program) | 0.66 s | 5.38 s | 6.65 s |
| child peak RSS | 265 MB | 200 MB | 125 MB |

(Consistent with spike 2's 8.5× on the type-checker. Server start to first answer is about 0.6 s on QuickJS.)

### Extension sweep (spike 3's harness, now with the fork/spawn/net/ESM layer)

`data/extension-sweep.jsonl`: **29 activated, 5 not triggered by the fired events, 0 failures**; spike 3 had 24 / 5 / 4 blocked on fork / 1 activation error. Newly activated: css, html, json, markdown language features (their servers run), `github` (ESM extension, previously an activation error). `git` activates again (it needs `fs.promises.copyFile`/`cp` and `stream/web` names for its ESM-only dependencies, added here). The 5: `github-authentication`, `microsoft-authentication`, `markdown-math`, `media-preview`, `vscode-api-tests`.

### Process and IPC micro-benchmarks (`tests/stress.cjs`, same script on each runtime; ms)

| | Node | QuickJS x86-64 | QuickJS x86-32 |
|---|---|---|---|
| 100 sequential `spawn('true')` to close | 287 | 196 | 211 |
| 32 MB through `cat` (stdin → stdout, back-pressure) | 51 | 57 | 57 |
| child writes 64 MB to stdout | 79 | 86 | 82 |
| 16 concurrent children | 300 | 275 | 268 |
| fork + first IPC message from the child | 32 | 18 | 21 |
| 2,000 IPC round trips | 129 | 172 | 189 |
| 20 MB of 100 KB IPC messages, one way | 64 | 214 | 248 |

All results (exit codes, signals, `execFile` timeout/`maxBuffer`/failure, `spawnSync` with input and timeout, `execSync`, kill by signal) were equal on the three runtimes, with one known divergence: Node truncates `spawnSync` output at the 1 MiB default `maxBuffer` (ENOBUFS), this implementation caps and kills but may return more (8,000,000 bytes in the test).

### Module loading (`tests/esm-fixture/main.mjs`, run with `$R`)

A package with `exports` conditions (`import` vs `require` entries), a CJS-only package imported with default and named imports, `node:` builtins, `createRequire`, `require()` of an ES module, dynamic `import()` and a missing package all behave as on Node (Node itself rejects the named import of a non-lexable CJS export; this host accepts it, a superset). `require(esm)` is synchronous and refuses top-level await with `ERR_REQUIRE_ASYNC_MODULE`. The ESM `vscode` import hook of the real extension host (a `data:` URL answer) works, which is what activated `github`.

## Findings that change the plan

1. **Windows event loop.** In QuickJS-ng's `quickjs-libc.c` the `_WIN32` branch of the poll loop waits only for read handlers on fd 0 and for worker message ports. `os.setReadHandler` on a pipe or socket is accepted but never fires there. Everything in `fdstreams.js` therefore needs a different wait primitive on Windows: a host-owned loop (IOCP on NT; `select`/`WSAEventSelect` for sockets and helper threads for pipes on Win9x). The whole `child_process`/`net` layer above `fdstreams.js` is portable JavaScript; only the ~10 native calls below it change. **This is the main Windows risk found by this spike.**
2. **UTF-8 must be native.** The first IPC benchmark moved 20 MB in 5.7 s (Node 64 ms) because `TextDecoder`/`Buffer.toString` were JavaScript loops. Replacing both directions with QuickJS's own `JS_NewStringLen`/`JS_ToCStringLen` (two 8-line functions) gave 214 ms and also makes every `fs.readFile`-as-string and RPC decode faster. Any host should provide native `TextDecoder`, `TextEncoder` and probably `Buffer`.
3. **IPC channel design.** The Node protocol (`NODE_CHANNEL_FD`, one JSON message per line, `NODE_CHANNEL_SERIALIZATION_MODE=json`) is implemented on a `socketpair`. A Windows port can keep the protocol and swap the transport: a pair of inherited anonymous-pipe handles (handle numbers passed in the environment; anonymous pipes exist on every Windows including 98, **unverified here**) or loopback TCP. Like Node, the channel only keeps the child alive once a `'message'`/`'disconnect'` listener exists (implemented, tested with the forked clients that exit on their own).
4. **Native module hooks are small.** The resolver and loader hooks are `JS_SetModuleLoaderFunc2` callbacks into JavaScript; synchronous `require(esm)` is `JS_Eval` of a one-line wrapper module (`JS_LoadModule` answers through a promise, one microtask too late). QuickJS loads module graphs synchronously, so only top-level await is refused, the same limit as Node. This removes the need for spike 3's build-time pre-bundling of ESM dependencies.
5. **Process lifetime details cost a day each.** All found by tests, all in the shim: a listener on `process.on('message')` must attach lazily (an attached `data` listener keeps a QuickJS loop alive forever), a throwing `exit` listener must not stop reaping other children, a top-level `await` in the runner stalls microtasks until the next timer (spike 2's lesson again, forgotten once), `console.error` does not exist in QuickJS (undefined, not a stub). Worth carrying into the real host design as requirements.
6. **Plain classes break npm code.** The spike 2 `EventEmitter` was an ES class; `readable-stream` (and much of npm) calls `EventEmitter.call(this)`. It is now a function constructor.

## Caveats

- Linux only. The native layer uses `fork`/`exec`, `pipe2`, `socketpair`, `poll`, `accept4`; none of it exists on Windows, and the Windows notes above (anonymous pipes, IOCP, Win9x limits) are design analysis from the QuickJS source and general Windows knowledge, **not tested**.
- Streams are `readable-stream` 3.6.0 (Node 10 semantics). Real Node 24 code that needs `stream/promises`, `Readable.from`, `pipeline` with async iterables, `stream/web` or `AbortSignal`-aware streams was not exercised; `stream/web` is class names only.
- `net` has no DNS beyond blocking `getaddrinfo`, no `dgram`, no `tls`, no Windows named pipes, no handle passing over IPC (`send(msg, handle)`), no `advanced` serialization. `child_process` has no `uid/gid`, no `windowsHide`, no `timeout`/`signal` options for `spawn`, no `kill` of process trees.
- The CJS-vs-ESM decision for `.js` files without a `"type"` is a regex over the head and tail of the file (Node parses). It handled everything in this repo but is a shortcut. Named exports of CommonJS modules come from runtime `Object.keys`, not Node's static lexer.
- The fake renderer answers a few more requests (`$requestResourceTrust`) and sends a workspace/configuration on request (`WORKSPACE`, `CONFIG`, `OPEN_DOC`, `SPIKE5` env vars of `03-extension-loading/run_ext.mjs`); the LSP diagnostics push path (pull diagnostics need a visible editor) was not exercised, only symbols and completion.
- tsserver was measured on one 19-file project; `typingsInstaller`, `npm` and `--logFile` paths were not used (`--disableAutomaticTypingAcquisition`). The sweep activates extensions; it does not drive their features beyond the JSON/git scenarios above.
- No renderer exists: "the renderer" is the harness's fake `MessagePort`.
- Run-to-run noise on this shared VM is roughly ±10 to 15 %. The 32-bit numbers are one run each, on a 64-bit kernel.

## Changes to earlier spikes' files

Needed to get here; all small and additive: `02-node-shim/host/gen_shims.mjs` (`SHIM_IMPL_DIRS`, `stream/web`, `stream/consumers`), `globals.js` (native UTF-8 hook, `Buffer.allocUnsafeSlow/isEncoding/copy`, `Intl.ListFormat`), `impl/events.js` (function constructor, static `listenerCount`), `impl/util.js` (`format` of non-string first argument), `impl/fs.js` and `original-fs.js` (`copyFile`, `appendFile`, `readlink`, `symlink`, `utimes`, `rmdir`, `cp`, ENOSYS stubs), `impl/fs__promises.js`, `impl/module.js` (`_resolveBareEsm`, native `require(esm)`, conditions parameter); `03-extension-loading/run_ext.mjs` (SPIKE5/WORKSPACE/CONFIG/OPEN_DOC switches, cancellable requests).

## Reproduce

```
export PATH=<node 24>/bin:$PATH                       # repo root; production bundle in out-vscode-min/ (spike 2) for the extension host
bash docs98/spikes/05-child-process/host/setup.sh /tmp/s5 vs/workbench/api/node/extensionHostProcess.js bootstrap-fork.js
R="/tmp/s5.bin/qjs-spike5 --stack-size 0 docs98/spikes/05-child-process/host/fork_main.mjs /tmp/s5"
$R docs98/spikes/05-child-process/tests/fork_parent.cjs                # fork + IPC + kill + ENOENT
PEER=node $R docs98/spikes/05-child-process/tests/net_test.cjs         # TCP/unix/forked client/real Node peer
$R docs98/spikes/05-child-process/tests/esm-fixture/main.mjs           # resolution, CJS interop, require(esm); node runs it too (minus the non-lexable named import)
$R docs98/spikes/05-child-process/tests/stress.cjs                     # compare with: node tests/stress.cjs
TSSERVER=$PWD/extensions/node_modules/typescript/lib/tsserver.js PROJECT=<dir with .ts> $R docs98/spikes/05-child-process/tests/ts_parent.cjs
# extensions through the extension host (env: SPIKE5=1 NLS_MESSAGES=out-vscode-min/nls.messages.json; add OPEN_DOC=1 for a JSON document, WORKSPACE=/dir CONFIG='{"git":{"enabled":true}}' for git)
SPIKE5=1 /tmp/s5.bin/qjs-spike5 --stack-size 0 docs98/spikes/03-extension-loading/run_ext.mjs /tmp/s5 $PWD/extensions 800 json-language-features
# full sweep: see the run_sweep.sh invocation in the commit message history of this spike (SPIKE5=1 SHIM_IMPL_DIRS=<out>.impl QJS=<qjs-spike5>)
```
`VSCODE98_TRACE_PROC=1` logs every spawn, exit and child stderr. The test project for tsserver was 19 files copied from `src/vs/base/common/`.
