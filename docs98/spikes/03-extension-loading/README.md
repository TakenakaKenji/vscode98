# Spike 3 — Loading real extensions through `require()` on QuickJS-ng

**Question** (follows [../02-node-shim/README.md](../02-node-shim/README.md)): spike 2 left extension loading as the biggest open item for the extension host: extensions are CommonJS, loaded with `require()`, and VS Code intercepts `require('vscode')` by patching private `Module` internals. Can the extension host on QuickJS-ng load and activate VS Code's own built-in extensions?

- **Engine:** QuickJS-ng 0.17.0, same Linux/Xeon machine as the earlier spikes. **Extension host:** the production bundle (`out-vscode-min/`), unmodified apart from import rewriting (see spike 2). **Extensions:** the 34 built-in extensions in this repo that have compiled output (`extensions/*/out`, TypeScript compiler output, **not** the product's bundled/minified extensions).
- **Everything here is a Linux harness with a fake renderer**; no Windows, no real UI.

## Verdict

1. **Yes: 24 of the 34 built-in extensions load through `require()` and activate on QuickJS-ng**, each tested in its own fresh process. They include `git` (77 modules, with its `git-base` dependency), `typescript-language-features` (158 modules), `emmet` (40), `npm` (92) and `terminal-suggest` (156).
2. **`require('vscode')` interception works.** The extension host patches `Module._load`, `_resolveFilename` and `_resolveLookupPaths` exactly as on Node; a small CommonJS loader written in JavaScript on QuickJS ([host/impl/module.js](../02-node-shim/host/impl/module.js), ~120 lines) honours those patches. Activated extensions registered commands, providers, decoration types and storage through real RPC calls.
3. **4 more load completely and then stop at the same wall:** the language-client extensions (`css`, `html`, `json`, `markdown`; 139 to 367 modules each) call `child_process.fork()` to start their language server, which is not implemented. That is the next spike's job.
4. **1 fails for a reason that needs native code:** `github` is an ES-module extension whose `import 'vscode'` goes through `module.registerHooks`, which QuickJS's JS API cannot provide (it needs a C-level module resolver hook). The **5 that did not activate were not triggered** by the activation events the harness fires, not shown to be broken.
5. **Cost is small:** the host reports code-loading time per extension: median 7.5 ms, `typescript-language-features` 202 ms, `git` 142 ms, `terminal-suggest` 161 ms; whole-process peak memory 31 to 43 MB. These are unbundled dev-build extensions; the product's bundled ones would load faster.

## Results (34 extensions)

| Outcome | Count | Extensions |
|---|---|---|
| **Activated** | 24 | configuration-editing, debug-auto-launch, debug-server-ready, emmet, extension-editing, git (+ git-base), git-base, grunt, gulp, ipynb, jake, merge-conflict, mermaid-markdown-features, npm, php-language-features, references-view, search-result, simple-browser, terminal-suggest, tunnel-forwarding, typescript-language-features, vscode-colorize-perf-tests, vscode-colorize-tests, vscode-test-resolver |
| **Loaded, then blocked on `child_process.fork`** (language server) | 4 | css-language-features (139 modules), html-language-features (145), json-language-features (146), markdown-language-features (367) |
| **Failed** | 1 | github: ES-module extension, needs a native module-resolver hook for `import 'vscode'` |
| **Not triggered** by the events the harness fires | 5 | github-authentication, microsoft-authentication, markdown-math, media-preview, vscode-api-tests (they activate through contribution-derived events the harness does not synthesise) |

Raw per-extension rows (status, modules loaded, timings, stubbed calls, peak memory): [data/extension-sweep.jsonl](data/extension-sweep.jsonl).

"Activated" means the extension's own `activate()` ran and the host reported `$onDidActivateExtension` to the (fake) main thread. It does **not** mean the extension's features work: nothing was exercised after activation, and many of them (git, tsserver, language servers) only do their real work on later requests.

## How it was done

- **[host/impl/module.js](../02-node-shim/host/impl/module.js)**: `Module` with `_load`, `_resolveFilename`, `_resolveLookupPaths`, `_nodeModulePaths`, `_cache`; Node-style resolution (relative, absolute, `node_modules` walk, `package.json` `main`, `exports` with `node`/`require`/`module-sync` conditions, `.json`); a `createRequire` whose `require` always goes through `Module._load`; `registerHooks` (records hooks only); `require.resolve`, `require.cache`.
- **Builtins** (`require('fs')` etc.) resolve to the shim modules from spike 2 through a preloaded table; added this round: `util` (promisify, format, inspect, inherits...), `url`, `http`/`https` skeletons (real classes and constants, no networking), `process`, `buffer`, a no-op `@vscode/proxy-agent`, and an `fs` errno fix (`std.Error` holds the constants in QuickJS; `os.ENOENT` does not exist).
- **[run_ext.mjs](run_ext.mjs)**, the fake renderer: speaks the RPC wire format over the fake `MessagePort` (request `[1][reqId u32][rpcId u8][len][method][len u32][json args]`, replies `[7]`/`[9]`, proxy ids from [proxy-ids.json](proxy-ids.json), produced by [dump_proxy_ids.mjs](dump_proxy_ids.mjs) from the compiled protocol module). It answers every request the host makes (canned replies, all logged), sends what a real renderer sends after init (`$initializeConfiguration`, `$initializeWorkspace`, the editor tab model) and fires each extension's declared activation events through `$activateByEvent`.
- **[run_sweep.sh](run_sweep.sh)**: one fresh process per extension, then the table above.

### What the fake renderer had to supply (each was a real failure before it existed)
- Configuration model with all seven parts (`defaults`, `policy`, `application`, `userLocal`, `userRemote`, `workspace`, `folders`); without it the host waits forever in `getConfigProvider()`.
- Real answers to two requests: `MainThreadWindow.$getInitialState` (an object) and `MainThreadLanguageModelTools.$getTools` (an array). An empty reply makes the host's `.then` handlers throw.
- The editor-tab model (`ExtHostEditorTabs.$acceptEditorTabModel`) before `typescript-language-features` activates; it reads `window.tabGroups.activeTabGroup` immediately.
- An `appRoot` that contains `product.json` (extension-editing reads it), and per-extension log and storage directories the main thread would normally create.
- The NLS message table in `globalThis._VSCODE_NLS_MESSAGES` (a bootstrap duty).

## Findings that matter for the design

1. **`require(esm)` is the first thing QuickJS cannot do from JavaScript.** Node 24 lets `require()` load ES modules synchronously, and extension dependencies already rely on it: `file-type`, `@vscode/fs-copyfile`, `@vscode/hubrpc` and `@vscode/observables` are ESM-only. The JS API of QuickJS can only `import()` asynchronously, so those four had to be **pre-bundled to CommonJS with esbuild** and picked up from an overlay directory (the sweep does this automatically, up to 8 rounds). That mirrors what VS Code's own extension build does (it bundles built-in extensions), so for built-ins it is a packaging step. Third-party extensions with ESM-only dependencies would fail. A **native synchronous module loader** in the host (`JS_Eval` of a module plus `JS_GetModuleNamespace`) would fix it and is needed anyway for the next point.
2. **ESM extensions and `module.registerHooks` need a C-level hook.** The host resolves `import 'vscode'` for ES-module extensions with a `registerHooks` resolve hook that returns a `data:` URL. QuickJS exposes module resolution only through `JS_SetModuleLoaderFunc` in C. In this repo only `github` is an ES-module extension, but the pattern is the supported way for extensions to ship ESM.
3. **Catch-all stubs break TypeScript's interop helpers.** `request-light` (used by `json-language-features`) does `__importStar(require('http'))`, which copies enumerable properties. A stub proxy has none, so `http.Agent` came out `undefined` and `class extends undefined` died with "parent class must be constructor". Anything that goes through interop helpers needs a **real module object**; that is why `http`/`https` now have skeleton shims.
4. **Extensions load a lot of code up front.** `markdown-language-features` pulled in 367 modules, `terminal-suggest` 156, `typescript-language-features` 158 before `activate()` even ran. Total time was still small here, but on a slower CPU the code-loading phase is where QuickJS's 2 to 9× will show. Precompiled bytecode (spike 1) applies to extension code too and should be considered at packaging time.
5. **The extension-host/renderer contract is larger than a handshake.** The renderer owns state the host reads synchronously (tab model, window state, configuration, storage). A replacement main thread must provide it; which pieces are required is now enumerable from this harness.

## What this does NOT show
- **Nothing was exercised after activation.** No command ran, no provider was queried, no editor existed. Activation is the first step; a language feature working end to end is far beyond it.
- **No child processes, sockets or HTTP**: `child_process`, `net`, `http` requests, `zlib`, `crypto` (Node's), `stream` are stubs or skeletons. The four language-client extensions, `git` (spawns `git`), `npm`, tasks and anything networked are blocked there.
- **The 5 non-triggered extensions** were not activated by anything the harness fires; whether they would work is unknown.
- **Dev-build extensions**, not the product's bundled ones; timings and module counts will differ.
- **Third-party extensions**: only VS Code's own built-in ones were tried. Real-world ones use more of Node (and ESM-only dependencies, `child_process`, native addons).
- **Linux only**; fs error numbers and path handling are Linux's.

## What this means for the decisions
- **D-004:** the engine handles real extension code, including heavy CommonJS (webpack bundles, TypeScript helpers, `async` generators) without language-level problems. The new engine-side requirements are (a) a native module loader with a resolver hook and synchronous ESM loading, (b) unchanged: `Intl`, WebAssembly, speed.
- **D-006:** the extension-host/renderer boundary is `MessagePort` RPC with the framing used here; the host needs `child_process.fork` with an IPC channel for language servers (4 of 34 built-ins) and process spawning for git/npm/tasks.

## Reproduce
```bash
# prerequisites: QuickJS-ng built; out-vscode-min/ from `node --experimental-strip-types build/next/index.ts bundle --out out-vscode-min --target desktop --minify --mangle-privates --nls`;
# dev out/ from `npm run transpile-client` (only for dump_proxy_ids.mjs); Node 24 on PATH; built extensions (npm run gulp compile-extensions)
QJS=/path/to/qjs bash docs98/spikes/03-extension-loading/run_sweep.sh /tmp/hostdir /tmp/sweep.jsonl 800
# a single extension, with trace logging of every require:
TRACE_REQUIRE=1 NLS_MESSAGES=$PWD/out-vscode-min/nls.messages.json ESM_OVERLAY_DIR=/tmp/esm-overlay /path/to/qjs --stack-size 0 \
  docs98/spikes/03-extension-loading/run_ext.mjs /tmp/hostdir $PWD/extensions 800 git-base git
```
