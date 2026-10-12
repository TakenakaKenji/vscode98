# 05 — Decision Log

Format: ID, date, status (`accepted`, `proposed`, `rejected`, `superseded`), decision, rationale, alternatives.

## D-001 — Fork upstream `main`, shallow clone (2026-10-11) — accepted
- **Decision:** Work from `TakenakaKenji/vscode98` cloned with `--depth 1` from upstream `main` (1.142.0). Add `upstream` remote.
- **Why:** Full history is very large; deepen only when needed.
- **Alternatives:** Start from an old tag (Electron 22 era). Deferred; may be used for reference.

## D-002 — Disable git-lfs filter in this repo (2026-10-11) — accepted
- **Decision:** Local config `filter.lfs.*` set to `cat`, `required=false`.
- **Why:** `git-lfs` isn't installed; global config marks it required, which broke checkout. The only LFS file seen is an unrelated Copilot test cache.

## D-003 — Drop Electron by building a custom host, not by rewriting the UI natively (2026-10-11) — proposed
- **Decision:** Provide a minimal DOM/CSS/render layer + JS engine + Node shim so the existing workbench runs largely unchanged.
- **Why:** The workbench is ~1.1M lines written directly against the DOM; a native rewrite would lose most features. Goal is the full feature set.
- **Alternatives rejected:** (1) native toolkit rewrite — too large, loses extension compatibility; (2) WebView2/Tauri — requires newer Windows, defeats the goal; (3) plain Electron backport — can't reach XP/98.
- **Risk:** Performance of a small JS engine and a custom renderer; breadth of CSS needed. Phase 1 spikes test this.

## D-004 — JS engine — proposed (pending Phase 1)
- **Candidate:** QuickJS / QuickJS-ng. Others to compare: older V8 builds, Duktape, other embeddable engines.
- **Criteria:** buildable for Win 7/XP/98, ES level support, speed, memory, multi-context/worker support.
- **Evidence so far (spike 1, step 1, 2026-10-12):** QuickJS-ng 0.17.0 compiles all 30 bundle files unmodified (language level OK); workbench compile 2.8 to 3.4 s but 0.2 s from precompiled bytecode (so ship bytecode); 86 MB compiled heap for the workbench; lacks `Intl`, `WebAssembly`, `structuredClone` (must be supplied); its Windows sync layer uses Vista+ APIs (fine on Win 7, to be replaced for XP/98). **Spike 2 (execution speed, 2026-10-12):** on the TypeScript compiler QuickJS-ng gives identical results, is 8.5× slower than V8 with JIT (2.3× to 15× by phase) and 2.2× slower than V8's JIT-less interpreter, memory +15%; the Node-side bundles boot on it with a small shim ([spikes/02-node-shim/README.md](spikes/02-node-shim/README.md)). **Spike 3 (2026-10-12):** real extension code loads: 24 of 34 built-in extensions activate on QuickJS-ng through a ~120-line JS CommonJS loader; QuickJS cannot `require()` ES modules synchronously or take a module-resolver hook from JS, so a native module loader is needed for ESM-only dependencies (pre-bundled to CJS for now) and ES-module extensions ([spikes/03-extension-loading/README.md](spikes/03-extension-loading/README.md)). **Spike 4 (WebAssembly, 2026-10-12):** QuickJS-ng has no `WebAssembly`; `vscode-oniguruma` still runs on it three ways with identical results (wasm3 with a custom JS API, native libonig, wasm2c-translated C). Native and wasm2c match V8 per call, wasm3 does not (8× slower per call, 2.6× to 4.9× slower tokenization) so the engine needs a native Oniguruma (or wasm2c) module, not a general WASM interpreter; tree-sitter is experimental/default-off and unproven on wasm3 ([spikes/04-webassembly/README.md](spikes/04-webassembly/README.md)). ES5-only engines are excluded (esbuild cannot lower below ES2015). Details: [spikes/01-js-engine/README.md](spikes/01-js-engine/README.md). **Spike 5 (child processes, 2026-10-12):** on the same engine a forked tsserver gives identical answers to Node and runs 6.0× slower (1.12 s vs 6.73 s on a 19-file project; x86-32 8.3 s); an idle QuickJS child needs 4 MB RSS vs Node's 39 MB and the tsserver child peaked at 200 MB (125 MB as x86-32) vs 265 MB. Native UTF-8 conversion is required (a JS `TextDecoder` made IPC 60× slower); the engine's module-loader hooks are enough for Node's ESM resolution and synchronous `require(esm)` ([spikes/05-child-process/README.md](spikes/05-child-process/README.md)). Still `proposed`.

## D-005 — Render strategy — proposed (pending Phase 1)
- **Candidate:** Minimal DOM + CSS layout engine drawing via GDI.
- **Open:** how much CSS; Monaco rendering path; font/Unicode handling.
- **Evidence (spike 6, 2026-10-12):** a ~210 KB JS DOM + CSS + layout + software painter runs the real Monaco on QuickJS-ng; element geometry equals Chromium's (every non-SVG box within 0.5 px in 4 scenarios), framebuffers identical on Node and QuickJS. A static replay of the real workbench (the workbench's JS was not run on it) puts 422 of 566 boxes within 1 px and 924/975 `offsetWidth` values right; the CSS surface needed is block/inline/inline-block/absolute/fixed/relative/flex, no grid/float/table. Known gaps: SVG, `box-shadow`, rounded borders, rotation, kerning for Inter, `env(titlebar-area-*)`, Canvas 2D. **Cost:** on QuickJS one cold workbench pass is 7.3 s style+layout and 3.3 s paint (5.7× and 11× slower than Node), so layout and rasterization must be native; whether the DOM/style stay in JS depends on interactive load, not measured. Not tested: GDI/Windows, the workbench running on this DOM (events, focus, IME), webviews (table layout), 64-256 MB RAM budgets. Details: [spikes/06-rendering/README.md](spikes/06-rendering/README.md).

## D-006 — Process and IPC model — proposed (pending Phase 1)
- **Open:** processes vs threads for UI / extension host / shared process; replace Electron IPC with named pipes or sockets.
- **Evidence so far (spike 2, 2026-10-12):** the extension host talks to its renderer over one `MessagePort` obtained from `process.parentPort`: `Ready` → init JSON → `Initialized` → length-framed RPC. Four Node-side bundles run as separate QuickJS instances in 11 to 33 MB each. A replacement host needs `MessagePort`-style endpoints (or an adapter with `on('message'|'close')`, `start`, `postMessage`). Details: [spikes/02-node-shim/README.md](spikes/02-node-shim/README.md).
- **Evidence (spike 5, 2026-10-12):** child processes use Node's own protocol (`NODE_CHANNEL_FD`, one JSON message per line) over a `socketpair`; spawn, fork, pipes and TCP/unix sockets are as fast as Node's (32 MB through `cat` 57 ms vs 51 ms; 2,000 IPC round trips 172 ms vs 129 ms). The language servers and tsserver need exactly that and nothing else. On Windows the engine's stock event loop waits only on stdin and worker ports, so the process/IPC layer needs a host-owned loop (IOCP on NT; sockets + helper threads on Win9x; unverified). The IPC transport can be inherited anonymous-pipe handles or loopback TCP without changing the protocol. [spikes/05-child-process/README.md](spikes/05-child-process/README.md).

## D-008 — Scope out AI/agent/cloud features for old Windows (2026-10-11) — accepted
- **Decision:** Exclude `platform/agentHost`, Copilot/Anthropic/MCP SDKs, dev-tunnels, playwright, and similar from the old-Windows builds.
- **Why:** They need modern TLS, modern Node, and cloud services, and make up a large share of the npm imports (see [inventory/native-modules.md](inventory/native-modules.md)). They don't fit the "work on projects on old machines" goal. The owner confirmed.
- **Known consequence:** The Claude Code extension, which the owner uses heavily, will not run on the old targets (CPU/runtime limits). The owner will work around that later. Candidate ideas, none evaluated yet: use it from a modern machine against the same project, or a remote/terminal-based workflow.
- **Open:** exact list of modules/folders to exclude is to be produced during inventory pass 2.

## D-007 — Project docs location (2026-10-11) — accepted
- **Decision:** All project docs live in `docs98/` with `INDEX.md` as table of contents; root `CLAUDE.md` points to it.
- **Why:** Keep project-specific files out of upstream paths to ease merges; make context easy to reload.
