# Inventory — Method and Summary

Phase 0 of [../04-roadmap.md](../04-roadmap.md). Goal: measure what VS Code actually requires from its host (Chromium, Node, Electron), so we can size the replacement.

- **Taken at:** commit `32bbe1b8` (upstream 1.142.0, 2026-10-11).
- **Scope:** `src/vs/**`, excluding `test/` and `node_modules/`. Built-in `extensions/` and `build/` are **not** yet covered (see "Not yet covered").
- **Unit:** mostly **number of files** matching a pattern, not number of call sites.

## How to reproduce

From the repo root:

```bash
python3 -I docs98/inventory/scripts/scan_imports.py   src/vs /tmp/imports.json   # Node + Electron + npm imports, by layer
python3 -I docs98/inventory/scripts/scan_electron.py  src/vs                      # named Electron imports
bash docs98/inventory/scripts/scan_web_and_lang.sh                                # Web API / CSS / language-feature file counts
```

## Accuracy caveats

- Counts are regex file-matches; they **over-approximate** (e.g. `Animation\b`, `Range`, `@` decorators, `TouchEvent|GestureEvent` also match unrelated identifiers). Treat them as order-of-magnitude, and read the code before relying on any single number.
- They **under-approximate** anything accessed indirectly (e.g. DOM through helper functions in `base/browser/dom.ts`, Node via wrappers in `base/node`).
- The workbench now contains large AI/agent areas (`platform/agentHost`, Copilot/Anthropic SDKs). Many of the npm imports in the tables come from there; those features are probably out of scope for old Windows (see D-008 proposal in [../05-decisions.md](../05-decisions.md)).

## Headline findings

1. **The Electron surface is small and well-contained.**
   - Only ~52 files import `electron`; 47 of them are in `electron-main`, 3 in `electron-browser`, 1 in `electron-utility`.
   - The renderer touches Electron only through **one preload bridge** (`src/vs/base/parts/sandbox/electron-browser/preload.ts`) that exposes `ipcRenderer`, `ipcMessagePort`, `webFrame`, `webUtils`, a limited `process`, and `context` as `globalThis.vscode`. That bridge is the natural seam for our host. → [electron-apis.md](electron-apis.md)
2. **Direct Node usage is narrow.** Only 25 distinct Node built-ins are imported in `src/vs` and most are in `node/` layers. `fs`, `os`, `child_process`, `crypto`, `http`, `net` dominate. VS Code ships its own `path` implementation (`base/common/path.ts`). Globals (`Buffer`, `process`) are used widely without import. → [node-apis.md](node-apis.md)
3. **The DOM/CSS surface is large but conventional.** 471 CSS files (~92k lines) use flexbox heavily (287 files), custom properties (408), `calc()` (103), grid (39), pseudo-elements, `:has()` (34), `color-mix` (59), plus transforms/transitions/animations. No exotic features dominate, but a custom layout engine must cover a lot of CSS. → [dom-and-web-apis.md](dom-and-web-apis.md)
4. **WebAssembly is a host requirement.** `vscode-oniguruma` (TextMate regex engine, needed for syntax highlighting), `@vscode/tree-sitter-wasm`, and likely `libsodium` ship as WASM. A JS engine without WASM support (e.g. plain QuickJS) needs a separate WASM runtime, or these must be replaced with native builds. → [native-modules.md](native-modules.md)
5. **JS language level is very modern.** TS and esbuild targets are `ES2024`. Heavy use of async/await, optional chaining, `??`, private `#fields`, regex lookbehind and named groups, `for await`, generators, `Intl.Segmenter`. A small engine must support these or the build must downlevel. → [js-language-level.md](js-language-level.md)
6. **Native modules are numerous**: ~10 Windows-relevant compiled modules, each needing a port per target OS. → [native-modules.md](native-modules.md)
7. **External webviews/iframes are limited in code but required by the extension API** (markdown preview, notebooks, custom editors). A real HTML engine is the only complete solution.

## Not yet covered (next inventory passes)

- Built-in `extensions/` (106 dirs): what Node APIs and bundled modules each uses; which ship their own language servers/binaries.
- `build/`: bundling, NLS, packaging steps that assume Node 22/24 or Electron.
- Actual CSS property/value inventory (distinct properties, selectors) instead of per-feature file counts.
- Runtime tracing: start real VS Code and record which DOM/Node APIs are *executed* at startup and for common tasks (more reliable than static grep).
- Extension ecosystem: top Marketplace extensions' use of Node APIs and native binaries.
- Size/perf baseline: memory use and startup time of stock VS Code, for budgeting.
