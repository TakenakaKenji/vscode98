# Spike 2 — Execution speed and the Node-side shim (step 2 of Phase 1)

**Questions** ([04-roadmap.md](../../04-roadmap.md), D-004, D-006): (A) how fast does QuickJS-ng *execute* real, heavy VS Code-type JavaScript compared with V8? (B) how much Node/Electron environment does the Node-side half of VS Code (extension host, shared process, pty host, file watcher) need to start on QuickJS-ng?

- **Engine:** QuickJS-ng 0.17.0 (`9b06171`), release build. **Machine:** Intel Xeon @ 2.1 GHz, 4 vCPU, Linux cloud VM. **Node:** 24.18.0 (V8 JIT unless noted).
- **Follows:** [../01-js-engine/README.md](../01-js-engine/README.md) (compile-only test).
- **Everything here is Linux and a fast server core.** Ratios between engines are the useful output; absolute times are not Windows 7 predictions.

## Verdict in five lines

1. **Correctness: QuickJS-ng gave identical answers to Node** on a 148-file TypeScript type-check and completion queries (same file count, same 29 diagnostics, same 115 completion entries).
2. **Speed: QuickJS-ng is 8.5× slower than V8 with JIT** overall on that workload (2.3× to 15× depending on phase), and **2.2× slower than V8 with its JIT switched off.** Interpreter-for-interpreter, V8's Ignition is still ~2× faster.
3. **The four Node-side bundles (extension host, shared process, pty host, file watcher) load and reach their "waiting for the parent" state on QuickJS-ng** with about 260 lines of shim JavaScript, in 26 to 450 ms of evaluation and 11 to 33 MB of memory.
4. **The extension host goes further:** given a crafted init message over a fake message port it constructed itself, built its RPC layer and sent 10 real RPC requests to the "main thread" (register commands, search provider, task system, logger...) within about 10 ms of receiving the init message, with no errors.
5. **Not yet exercised:** loading any extension, `net`, `child_process`, `http`, real `require` (CommonJS), native modules. These are the next real requirements.

## Part A — engine speed on a real workload

**Workload:** the TypeScript compiler that `tsserver` runs (`extensions/node_modules/typescript` 6.0.3, `typescript.js` 9.1 MB), type-checking `src/vs/base/common/*.ts` (110 root files pulling in 223 files including `lib.dom.d.ts`) with the repo's own compiler options (strict, ES2024, NodeNext), then 15 language-service completion requests. The same JavaScript file ([ts_bench_core.mjs](ts_bench_core.mjs)) runs under both engines; only a small adapter for file access and the clock differs ([run_node.mjs](run_node.mjs), [run_qjs.mjs](run_qjs.mjs)). TypeScript's own `ts.sys` is deliberately not used, so no Node shim is involved in the timing. Three runs per engine, medians; raw data in [data/](data/).

| Phase (median ms) | Node, JIT | Node `--jitless` | QuickJS-ng | QuickJS / JIT | QuickJS / jitless |
|---|---|---|---|---|---|
| evaluate `typescript.js` | 250 | 221 | 579 | 2.3× | 2.6× |
| create program (parse + resolve imports) | 751 | 4,405 | 6,891 | 9.2× | 1.6× |
| type-check all 148 source files | 2,853 | 8,630 | 19,349 | 6.8× | 2.2× |
| 15 completion requests (first one rebuilds the program) | 743 | 4,945 | 11,377 | 15.3× | 2.3× |
| **total** | **4,656** | **18,216** | **39,432** | **8.5×** | **2.2×** |
| peak RSS (MB) | 489 | 429 | 564 | | |

Run-to-run spread of the totals: Node 4.3 to 5.2 s, jitless 17.9 to 18.7 s, QuickJS 37.4 to 39.8 s. Node's very first run (cold file cache) took 7.3 s; the table uses the warm runs.

Reading it:
- **The JIT is worth ~4× on this workload** (jitless 18.2 s vs JIT 4.7 s); **QuickJS-ng is a further ~2.2× behind V8's interpreter.** Any engine without a JIT should be expected to land around 8× behind modern Chrome-class V8 on compute-heavy code like this.
- **Module-evaluation work is closer** (2.3×): loading code is cheaper than crunching with it. VS Code's startup is mostly module evaluation and registration, so its slowdown could be at the low end of the 2 to 9× range, but **this was not measured on the workbench** (it needs a DOM). Treat "2 to 9×" as a range, not a prediction.
- **"First completion request 10.9 s vs 1.25 s" is not a per-keystroke latency**: the first request includes building the language service's own program (a second parse and check). Steady-state requests were not separated out.
- Memory is similar (+15% over Node), far from the 5 to 10× some expect from an embedded engine, because the working set is dominated by the compiler's own data structures.

**A finding by the way:** the TypeScript compiler itself needs `Intl.Collator` (completion sorting); the first QuickJS run died on `ReferenceError: Intl is not defined` after 40 s. A stand-in `Intl.Collator` (using `localeCompare`) lives in `run_qjs.mjs`. This confirms from a second, independent code base what spike 1 found in VS Code's own bundle: **`Intl` is a hard requirement for the engine's host.**

### Caveats for part A
- One workload, one machine. It is compute- and allocation-heavy; the workbench mix (DOM calls, many small closures, string building) will differ.
- V8 uses extra threads (concurrent GC and compile) on this 4-core box; QuickJS is single-threaded. On a single-core target the gap to V8 could narrow in wall-clock terms (not measured).
- The QuickJS `Intl.Collator` stand-in changes completion ordering, not the entry count (115 in all engines).

## Part B — booting the Node-side bundles on QuickJS-ng

**Method** ([host/](host/)): there is no `fs`/`net`/`electron` on QuickJS, so
1. [gen_shims.mjs](host/gen_shims.mjs) copies the production bundle entry files, rewrites their non-relative imports (`fs`, `node:net`, `electron`, `@vscode/spdlog`, ...) to generated shim modules, and creates a shim per module that re-exports every imported name: the real implementation from [host/impl/](host/impl/) when one exists, otherwise a **lenient stub** (a callable Proxy that records the call and returns another stub, so evaluation continues and we learn what is touched).
2. [globals.js](host/globals.js) provides the globals the bundles expect: `process` (incl. `parentPort`), timers, `Buffer`, `URL`, `TextEncoder/Decoder`, `crypto`, `structuredClone`, `AbortController`, a minimal `Intl`.
3. [run_entry.mjs](host/run_entry.mjs) loads the NLS messages (a duty of VS Code's own bootstrap), evaluates one bundle, hands it a fake `MessagePort` when it waits on `process.parentPort`, optionally sends a crafted init message, and reports everything the bundle did.
4. [run_bundles.sh](host/run_bundles.sh) does all of it for the five entries. Results: [data/node-bundles-on-quickjs.jsonl](data/node-bundles-on-quickjs.jsonl).

**Results** (wall time includes a fixed 3 s settle wait in the runner; the interesting numbers are `evalMs` and memory):

| Bundle | Top level evaluates | Evaluate (ms) | Peak RSS (MB) | Reached |
|---|---|---|---|---|
| extension host | yes | 260 | 32 | waits for its renderer's message port; sends `Ready` (the real handshake byte) once given one |
| extension host + crafted init data | yes | 277 | 32 | replies `Initialized`, constructs `ExtensionHostMain`, sends **10 RPC requests** (`$registerLogger` ×2, `$getInitialState`, `$registerCommand`, `$registerProcessSupport`, `$registerTextSearchProvider`, `$registerTaskSystem`, `$registerSupportedExecutions` ×2, `$getTools`); no errors forwarded |
| shared process | yes | 172 | 23 | waits for parent message |
| pty host | yes | 38 | 11 | waits for parent message |
| file watcher | yes | 26 | 11 | waits for parent message |
| `bootstrap-fork.js` (the real utility-process entry) → extension host | yes | 446 | 33 | starts the extension host and sends `Ready` |

(The extension host numbers are before any extension is loaded; a loaded workspace would add to both time and memory.)

**What it took:** about **260 lines of shim JavaScript**: `globals.js` 132, `fs` 62 (sync + callback + promises, on `qjs:os`/`qjs:std`; `original-fs` is a copy), `path` 21, `events` 21, `os` 7, `spdlog` 14, `fs/promises` 3; plus about 115 lines of generator and runner. Everything else the bundles import (about 45 modules) is stubbed and was either never called or harmless: during the extension host's start **only 6 distinct stubbed APIs were touched**: `module.createRequire` (accessed or called 9 times in total), `module.registerHooks` and the `minimist` argument parser.

**What the bundles proved they need** (each was a failure the shim had to fix): `crypto` (Web Crypto) at import time; the NLS message table loaded by the host (`globalThis._VSCODE_NLS_MESSAGES`); `process.parentPort` with `on('message')` delivering a `MessagePort`-like object (`on('message'|'close')`, `start()`, `postMessage`); `Buffer`, `TextDecoder`, `URL`; the `spdlog` native logger (without it the host forwards two console errors to the renderer, then continues).

### Findings that matter for the design

1. **The IPC shape of D-006 is concrete now.** The extension host's transport in a utility process is one `MessagePort` obtained from `process.parentPort`; the handshake is `Ready` (byte 2) → init JSON → `Initialized` (byte 1) → length-framed RPC messages. A replacement host needs `MessagePort`-style endpoints (or an adapter exposing the same `on('message')/postMessage/start/close` surface) between its processes or threads; nothing more Electron-specific was touched in this path.
2. **QuickJS-ng's stock `qjs` loop is not a drop-in host loop for promise-heavy code.** With a top-level `await` in the main module, `js_std_await` runs **one pending job per iteration and then polls timers**, so every `await` in the bundle waited for a timer wake-up (observed as startup stalling for up to the next timer). Removing the top-level `await` (running the entry from a plain function) restored normal draining via `js_std_loop`. A real host should drain `JS_ExecutePendingJob` fully each turn.
3. **Native modules are the real boundary.** `@vscode/spdlog` needed a JS stand-in; `node-pty`, `@parcel/watcher`, `@vscode/sqlite3`, `native-keymap`, `windows-process-tree` are still stubs. These were not touched at startup but are needed for terminals, watching and storage.
4. **ES modules with specifier rewriting work**: the engine's module loader handled absolute shim paths, static and dynamic `import()`, and bundles up to 2.2 MB. A real host would instead install a resolver hook (as `bootstrap-esm.ts` does in Electron).

### What this does NOT show yet
- **`require`/CommonJS:** `module.createRequire` is stubbed and was called 9 times. Extensions are CommonJS and are loaded through it (plus `registerHooks` interception), so **extension loading is untested and is the biggest open item for the extension host.**
- **`net`, `child_process`, `http`, `stream`, `crypto` (Node's), `zlib`, `readline`**: stubbed and not called at startup in these runs. The real host-to-renderer path uses a `MessagePort`; sockets, pipes and process spawning appear when features run (git, terminals, search via `rg`, language servers).
- **A real renderer**: the "main thread" here is a fake port plus a hand-written init message. The RPC replies were not answered, so nothing beyond the initial burst happened.
- **Performance of real extension activation**, memory with real extensions, and anything on Windows.
- Only Linux semantics (`fs` paths, no Windows drive letters, no `win32` path module).

## What this means for D-004 and D-006 (both still `proposed`)

- **D-004 (engine):** QuickJS-ng remains viable on language support, correctness and memory. The cost is speed: expect **roughly 2× to 9× slower than modern V8 depending on workload, ~2× slower than V8's interpreter**, before accounting for an old CPU. Precompiled bytecode (spike 1) removes the compile cost. A faster engine (a JIT, or a modern interpreter) would help; the choice should be revisited once the workbench itself runs.
- **D-006 (process/IPC):** the Node-side processes can be QuickJS instances connected by `MessagePort`-like channels; the surface they need at startup is small and now enumerated. Whether they are separate OS processes or threads in one engine is still open (memory: 11 to 33 MB each here).

## Reproduce
```bash
# part A (Node 24 on PATH; QuickJS-ng built; run from the repo root; the repo's extensions/node_modules/typescript must exist)
QJS=/path/to/qjs bash docs98/spikes/02-node-shim/run_ts_bench.sh /tmp/tsbench 3
# part B (needs out-vscode-min/ from: node --experimental-strip-types build/next/index.ts bundle --out out-vscode-min --target desktop --minify --mangle-privates --nls)
QJS=/path/to/qjs bash docs98/spikes/02-node-shim/host/run_bundles.sh /tmp/hostrun
```
