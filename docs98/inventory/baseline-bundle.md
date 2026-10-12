# Baseline — Production Bundle, Startup Time and Memory

The numbers a replacement host has to beat or match, measured on **stock VS Code 1.142.0 (`32bbe1b8`+docs)** in its bundled ("production") form and, for comparison, in dev mode. Linux, Electron 43.7.7, headless, no GPU, **4 cores / 15 GB RAM cloud VM**, 3 runs per mode, fresh profile and a near-empty workspace each time. This is a Linux build, not a Windows one: treat the absolute numbers as a *reference point*, not a Windows 7 prediction.

- **Tools:** [scripts/stage_bundled_app.ts](scripts/stage_bundled_app.ts) (stages a packaged-app-shaped directory), [scripts/run_baseline.sh](scripts/run_baseline.sh), [scripts/measure_baseline.mjs](scripts/measure_baseline.mjs) (CDP + `/proc`; **no tracing hooks loaded**, so the numbers are not skewed by the API counters).
- **Data:** [data/baseline/](data/baseline/) (`summary.json` + the six raw runs).
- **Re-run:** `node --experimental-strip-types build/next/index.ts bundle --out out-vscode-min --target desktop --minify --mangle-privates --nls`, then `bash docs98/inventory/scripts/run_baseline.sh <workdir> bundle 9334 20 3` and `... dev 9335 20 3`.

## How the bundle was built

`runEsbuildBundle` in `build/lib/esbuild.ts` is a thin wrapper around `build/next/index.ts bundle`. The task `esbuild-bundle-linux-x64-min` that I first tried **does not exist as a registered gulp task** (it only appears inside larger series such as `core-ci`), so the script is called directly with the flags the product build uses (`--minify --mangle-privates --nls`, desktop target). The full packaging task (`vscode-linux-x64-min`) was **not** run: it also compiles the Copilot extension and fetches built-in extensions from the marketplace.

| Metric | Value |
|---|---|
| Bundle time | **3:10 wall, 4.9 GB peak RSS** (`/usr/bin/time -v`; the bundler needs `--max-old-space-size=8192`-class memory) |
| Output | `out-vscode-min/`, **319 MB, 332 files**: 30 JS files (**58.0 MB**), 31 source maps (249 MB), 3.7 MB CSS, 126 PNG (under 1 MB in total), 52 SVG (~1 MB), 44 MP3 (~3 MB, accessibility sounds), 246 resource files copied |
| Dev-mode equivalent | `out/` has 10,065 JS files, 222 MB of unbundled JS |
| Largest JS | `workbench.desktop.main.js` **20.6 MB** (the workbench), `sessions.desktop.main.js` 21.7 MB (the separate agent "sessions" window, out of scope for old Windows by D-008), `agentHostMain.js` 3.6 MB (also D-008), `extensionHostProcess.js` 2.3 MB, `extensionHostWorkerMain.js` 2.0 MB, `sharedProcessMain.js` 1.5 MB, `nls.messages.js` 1.4 MB, `mainImpl.js` 1.3 MB, `cliProcessMain.js` 0.7 MB, `ptyHostMain.js` 0.35 MB, `editorWebWorkerMain.js` 0.33 MB, text-mate tokenization worker 0.25 MB |
| Needed to run it | `node_modules.asar` (370 MB with production dependencies) + `node_modules.asar.unpacked` (178 MB: `.node` and `.wasm` files and a few directories) next to `out/`, `extensions/`, `package.json`, `product.json` |

### The bundle's JS level (the key finding for the engine decision)

- **esbuild target is `es2024`** (`build/next/bundle.ts`, `transpile.ts`): nothing is lowered. Bundling changes the *shape* (30 files instead of 10,000) but **not the syntax level**.
- **Output is still ES modules**: `import … from` statements in the process entry points (`mainImpl.js` 114, `extensionHostProcess.js` 57, `sharedProcessMain.js` 72) and dynamic `import()` (11 in `workbench.desktop.main.js`, 33 in `mainImpl.js`); `import.meta` 4×. The workbench file itself has 14 `export` statements and no static `import … from`. So the host must still implement an ES module loader (static + dynamic `import`, `import.meta`), not just run one script.
- Syntax counts in `workbench.desktop.main.js` (minified; regex counts, small false-positive risk): optional chaining ~20,900, `??` ~8,000, logical assignment (`||= &&= ??=`) ~700, class `static{}` blocks ~2,760, regex lookbehind 14, private `#fields` ~41 (after `--mangle-privates`, which rewrites most private fields), async/await in the tens of thousands of tokens, `=>` ~40,000. **No `using`, no `SharedArrayBuffer`/`Atomics`, `WebAssembly` is not referenced in any bundled JS file** (the WASM glue lives in `vscode-oniguruma`/tree-sitter packages loaded from `node_modules`; when `onig.wasm` was missing the renderer logged `Failed to fetch`, which presumably disables TextMate tokenization, not verified further: see below).
- **WASM is still required** and is resolved from `node_modules.asar.unpacked/…/onig.wasm` in a packaged layout.

## Startup (time to a usable workbench)

"Ready" = `document.readyState === 'complete'` and the workbench DOM has the editor part and the status bar, polled over CDP every 100 ms from the moment the process was launched.

| | Bundled | Dev (unbundled `out/`) |
|---|---|---|
| Time to ready, 3 runs (ms) | **2377, 2508, 2397** (median 2397) | 12848, 12553, 13710 (median 12848) |
| `code/didLoadWorkbenchMain` (renderer clock, ms) | **1410** (loading + evaluating the 20.6 MB `workbench.desktop.main.js`: ~1.29 s after `willLoadWorkbenchMain` at 124 ms) | 11057 (thousands of module files) |
| `code/LifecyclePhase/Ready` / `Restored` | 1474 / **1971** | 11456 / 12028 |
| `code/willLoadExtensions` | ~2059 | not captured |

Reading: **in the bundled form about 65% of the renderer's time to a restored workbench is loading and evaluating the workbench bundle** (1.29 of ~1.97 s), on V8 with JIT on a modern server CPU. A host with a slower or interpreted JS engine pays that multiplied: this is the number that makes the D-004 engine question concrete. (Electron's main process also logs `node-compile-cache: packaged cache inactive` in both modes; a real packaged build with a V8 code cache would be somewhat faster than shown.)

## Memory

Per-process resident (RSS) and proportional (PSS, shared pages split among processes) memory summed over the whole process tree, plus the renderer's JS heap from CDP `Performance.getMetrics`. Medians of 3 runs. "Idle" = 20 s after ready, nothing opened beyond the empty workbench.

| | Bundled, +1 s | Bundled, idle | Dev, +1 s | Dev, idle |
|---|---|---|---|---|
| Processes in the tree | 10 | 10 | 13 | 11 |
| Total RSS (MB) | 1406 | **1484** | 2131 | 1822 |
| Total PSS (MB) | 761 | **838** | 1481 | 1093 |
| Renderer JS heap used / total (MB) | 70.5 / 107.3 | **77.7 / 130.7** | 133.1 / 151.4 | 111.4 / 128.7 |

Bundled idle, by process kind (median of 3, MB):

| Kind | Count | RSS | PSS | Notes |
|---|---|---|---|---|
| Node utility processes (`node.mojom.NodeService`) | 4 | 688 | 383 | four of: shared process, extension host, file watcher, pty host, agent host (the earlier process trace saw all five start in a scripted session; which four were alive at idle was not recorded, because they all report the same sub-type) |
| Renderer | 1 | 344 | 284 | workbench window; JS heap is ~78 MB of this |
| Main | 1 | 196 | 107 | Electron main (browser) process |
| Zygote | 2 | 106 | 25 | Chromium process launcher (Linux only) |
| Network service | 1 | 76 | 21 | Chromium; a replacement host does its own networking |
| GPU process | 1 | 75 | 21 | Chromium (software rendering here) |

So, for the project's purposes: **the work VS Code itself does costs roughly 0.7 GB of private-ish memory at idle with an empty workspace** (utility Node processes + renderer + main PSS ≈ 774 MB of the 838 MB); the Chromium helper processes (zygote, network, GPU) add only ~70 MB PSS and disappear in an Electron-free host. For comparison, [../03-targets-and-limits.md](../03-targets-and-limits.md) puts many XP machines at 512 MB to 2 GB of RAM, a 32-bit process at ~2 GB of address space, and the practical ceiling on Win 98 at around 512 MB (that last figure is marked unverified there). **This empty-workspace idle footprint (~0.8 GB PSS, ~1.5 GB RSS) already exceeds the lower end of those budgets**, before opening a real project. The dev-mode runs also had a JSON language server alive (107 MB RSS / 38 MB PSS); `tsserver` was not started by this near-empty workspace and was **not measured**.

## Caveats

- **Cloud VM, headless, software rendering, no GPU, tiny workspace.** Real desktops will differ. The `/proc` RSS counts shared libraries; PSS is the fairer number.
- **Dev-mode comparison runs are not equal to a shipping build either:** the dev idle process count (11) and DOM node count differ run to run, and the dev "+1 s" sample still includes load-time garbage (RSS falls from 2131 to 1822 MB at idle). Use the bundled column as the baseline.
- **The staged app approximates a packaged build, it is not one.** It uses the real bundle and a real `node_modules.asar` + `.asar.unpacked` built from production dependencies with `asar`, but: the asar is 370 MB because every production dependency folder is included as-is (the product build prunes more), the unpack list is a hand-written approximation of the one in `build/gulpfile.vscode.ts`, `@vscode/ripgrep-universal` is missing (the Copilot extension logs a `spawn … rg ENOENT` error; the system `rg` is not wired in), the built-in extensions are the dev-compiled ones (not the product's bundled/minified ones), and no V8 code cache is generated. Treat the extension-related numbers as approximate.
- **No functional verification beyond the startup path.** I confirmed the workbench rendered and no module-resolution or WASM errors remained in the log; I did not run the scenarios against the bundle.
- Timings come from a single machine with three runs each; the spread in the bundled runs was 131 ms (2377 to 2508).

## Packaging lessons learned (what a launcher needs)

1. **`bootstrap-esm.ts` installs a module-resolution hook that rejects bare packages resolving outside the app directory** (`Cannot find package '…' within the application resources`). A symlinked `node_modules` pointing at a checkout fails; the dependencies must really live under the app (or in `node_modules.asar`). A host that replaces Electron must either provide the same hook semantics or replace this resolver.
2. **WASM and native files must be physically unpacked.** With a plain `node_modules` directory and no archive, the renderer's request for `vscode-oniguruma/release/onig.wasm` failed with `ERR_FILE_NOT_FOUND`, first against `node_modules.asar.unpacked/…`, then (after I added an unpacked copy) against `node_modules.asar/…`. It only worked once a real `node_modules.asar` plus `node_modules.asar.unpacked` existed. I did not trace the code that chooses between those paths, so I can't say exactly which rule makes it ask for which.
3. **The renderer loads these files as plain files over `vscode-file://`** (the protocol handled by `net.fetch` in `ProtocolMainService`), so a replacement host's file loader has to serve both the bundle's `out/` and the application archive/unpacked trees.
4. The product bundle is built by a script (`build/next/index.ts`), not just gulp; its 4.9 GB peak memory means it must run on the developer's machine, not on the old target.
