# Spike 1 — JS engine: can QuickJS-ng load the bundle? (step 1 of Phase 1)

**Question** ([04-roadmap.md](../../04-roadmap.md), D-004): can QuickJS(-ng) parse and compile VS Code's production bundle, how slowly and with how much memory, which language features or built-ins are missing, and could a lowered build widen the choice of engines?

**Scope of this step:** compile-only. Nothing in the bundle was *executed* here (the workbench needs a DOM). Speed of execution is step 2 (Node shim + `tsserver` benchmark).

- **Engine:** QuickJS-ng 0.17.0, upstream `9b06171` (cloned into `/home/user/quickjs-ng/quickjs`, outside the repo), built with `cmake -DCMAKE_BUILD_TYPE=Release` (`-O3`).
- **Machine:** Intel Xeon @ 2.10 GHz, 4 vCPU, 15 GB, Linux (cloud VM). **A fast modern server core; an old target CPU will be several times slower. Absolute times are a reference point only.**
- **Input:** the 30 JS files of the production bundle `out-vscode-min/` built from this repo ([../../inventory/baseline-bundle.md](../../inventory/baseline-bundle.md)).
- **Files:** [parse_bench.c](parse_bench.c) (compile-only harness), [feature_probe.js](feature_probe.js) (built-in probe), [parse-all-bundle-files.json](parse-all-bundle-files.json) (raw results).
- **Re-run:** build QuickJS-ng, then `gcc -O2 -o parse_bench parse_bench.c -I$QJS -L$QJS/build -lqjs -lm -lpthread && ./parse_bench <file.js>` and `$QJS/build/qjs feature_probe.js`.

## Result 1 — syntax: everything parses, with zero changes

**All 30 bundle files compile as ES modules without a single error** (31.0 MB of source excluding the out-of-scope `sessions` and agent-host bundles). The bundle uses ES2024 syntax throughout (optional chaining ~20,900 uses, `??`, logical assignment, class `static {}` blocks ~2,760, regex lookbehind, private fields, top-level module syntax). No downleveling is needed for this engine.

Caveat: the harness resolves imports with a *stub loader* (bare specifiers such as `fs` or `electron` become empty modules; relative ones are compiled). This proves the code **parses and compiles**, not that named imports resolve or that it runs.

## Result 2 — cost of compiling it (the number that matters)

| File | Source | Compile | Compiled heap | Functions | Bytecode | Reload from bytecode |
|---|---|---|---|---|---|---|
| `workbench.desktop.main.js` | 19.7 MB | **2.8 to 3.4 s** (3 measurements) | **86 MB** | 111,049 | 56.6 MB | **0.18 to 0.25 s** |
| `extensionHostProcess.js` | 2.2 MB | 0.21 s | 10.7 MB | 14,180 | 6.4 MB | 35 ms |
| `extensionHostWorkerMain.js` | 1.9 MB | 0.15 s | 9.3 MB | 12,379 | 5.5 MB | 17 ms |
| `sharedProcessMain.js` | 1.4 MB | 0.11 s | 6.8 MB | 8,149 | 4.2 MB | 10 ms |
| `mainImpl.js` | 1.2 MB | 0.11 s | 7.1 MB | 7,796 | 4.6 MB | 10 ms |
| `ptyHostMain.js` | 0.3 MB | 22 ms | 1.8 MB | 2,302 | 1.1 MB | 2 ms |
| 30 files together | 55.3 MB | 7.4 s | | | | |
| 30 files minus `sessions` and agent host | 31.0 MB | 3.7 s | | | | |

Reading it:
- **Parsing the workbench bundle alone (no execution) already takes about twice as long as V8 needs to load and run it** (V8: ~1.3 s from `willLoadWorkbenchMain` to `didLoadWorkbenchMain` in the baseline). V8 compiles lazily; QuickJS compiles all 111k functions up front. On a CPU several times slower than this Xeon core the compile alone would plausibly take on the order of ten seconds or more per start (an estimate, not measured); precompiled bytecode avoids most of it.
- **Precompiled bytecode removes that cost:** reloading the same module from serialized bytecode takes ~0.2 s, about 11 to 16 times faster than compiling. QuickJS can write and read bytecode (`JS_WriteObject`/`JS_ReadObject`, `qjsc`), so the product should ship bytecode built at packaging time. Bytecode is tied to the engine version and must come from a trusted source (the API says so).
- **Memory:** the compiled workbench is ~86 MB of QuickJS heap before running any code; the process-level peak in the harness (258 MB) includes the source buffer, the serialized bytecode and the reloaded copy. Core process bundles add ~35 MB. The baseline's whole VS Code idles at ~0.84 GB PSS, of which the renderer is ~0.28 GB: so the compiled code is a sizable but not dominant part. Memory for *running* objects is not measured yet.

## Result 3 — lowering the bundle (is a weaker engine possible?)

`esbuild` 0.27.2 (run with `--minify-whitespace --minify-syntax`, so identifiers keep the original build's mangled names) lowered `workbench.desktop.main.js` to every target from ES2022 to **ES2015 with no errors**. **ES5 is impossible** (esbuild reports more than 56,000 errors and was killed after 58 s), so ES2015 is the floor for any engine, and engines limited to ES5 (e.g. Duktape-class) are out.

| Target | Size | QuickJS compile | Bytecode |
|---|---|---|---|
| original (ES2024, minified) | 19.7 MB | 2.8 s | 56.6 MB |
| ES2022 | 19.8 MB | 2.9 s | 56.8 MB |
| ES2020 | 19.8 MB | 3.4 s | 56.3 MB |
| ES2017 | 20.5 MB | 3.6 s | 57.9 MB |
| ES2015 | 20.8 MB | 3.1 s | 63.4 MB |

Lowering costs +5% size and +12% bytecode at ES2015, with compile times inside run-to-run noise. **Not verified:** that lowered code *behaves* identically (semantics such as async lowering to generators or TDZ for `let`/`const` could differ; needs execution), and that every engine has the library features the lowered code still needs.

## Result 4 — built-ins QuickJS-ng 0.17 does and does not have

[feature_probe.js](feature_probe.js) checked 68 features. **Present:** the entire ES2015 to ES2024 library surface VS Code can reach, plus `SharedArrayBuffer`, `Atomics`, `WeakRef`, `FinalizationRegistry`, `Array.fromAsync`, `Object.groupBy`, `Promise.withResolvers`, `toSorted`/`with`, ES2025 `Set` methods and iterator helpers, `Error.captureStackTrace` and `Error.stackTraceLimit`, `String.prototype.normalize/localeCompare`, and Unicode property regexes (`\p{Extended_Pictographic}`, `\p{Grapheme_Extend}`, `\p{Script=Han}` all work).

**Missing (what the host must provide), and whether the bundle needs it:**

| Missing | Bundle usage (workbench / extension host) | Verdict |
|---|---|---|
| **`Intl` (everything)** | `Segmenter` ×3 (word and grapheme segmentation in the editor), `DateTimeFormat` ×5/×2 (also `.resolvedOptions().timeZone`), `NumberFormat` ×2, `Collator` ×2 (sort lines), `Locale` ×2, `Segmenter.supportedLocalesOf` in config validation | **Hard requirement.** `safeIntl` in `src/vs/base/common/date.ts` only retries with default locales on a bad locale string; it does not guard against `Intl` being absent. Needs an `Intl` shim (en-only is a start; `Segmenter` needs UAX #29 rules on top of regex property escapes, QuickJS has no segmentation API). `localeCompare` (224 uses) exists |
| **`WebAssembly`** | not referenced in the bundled JS; used by `vscode-oniguruma` and tree-sitter, loaded from `node_modules` | **Hard requirement for syntax highlighting** (found in the bundle baseline: missing `onig.wasm` makes the renderer fail). Options: embed a WASM interpreter (e.g. wasm3) or replace those two packages with native bindings behind the same JS API |
| `structuredClone` | 4 / 1 uses | Small shim (or a JS deep-clone) |
| `TextEncoder`, `TextDecoder` | 23, 20 / 9, 8 | Host-provided Web API |
| `URL`, `URLSearchParams` | `new URL(` 88 / 24 | Host-provided |
| `AbortController` | 30 / 1 | Host-provided (small) |
| `setTimeout`/`setInterval` | everywhere | Host event loop |
| `MessageChannel`, `Worker`, `fetch`, `Blob`, `crypto.getRandomValues` | 6 `MessageChannel`, 1 `new Worker` in the workbench | Host-provided; `Worker` needs multiple engine contexts or threads |
| `Error.prepareStackTrace` (V8-only) | not found in the bundle counts above | No action seen |

These are part of the DOM/Web surface already inventoried in [../../inventory/](../../inventory/); the new information is that **`Intl` and `WebAssembly` are language-runtime-level gaps**, not DOM gaps, and need their own work items.

## Result 5 — QuickJS-ng and the older Windows targets

From reading the source (not built or run on Windows): QuickJS-ng's Windows build defines `_WIN32_WINNT=0x0601` (**Windows 7**) and its thread and sync layer (`cutils.h`) uses `InitOnceExecuteOnce`, `InitializeConditionVariable`, `WakeConditionVariable`, `SleepConditionVariableCS` and `_beginthread`. The condition-variable and one-time-init APIs are **Vista and later**. So:
- **Win 7: no obstacle seen.**
- **XP and 98: the engine's synchronisation layer would have to be replaced** (small, self-contained, but real work), on top of toolchain questions already listed in [../../03-targets-and-limits.md](../../03-targets-and-limits.md).

## What this says about D-004 (still `proposed`)

- **For QuickJS-ng:** it handles the full language level of the bundle unmodified, has the modern library surface, and compiles everything. On the **language axis it passes**; no downlevel build is required.
- **Against / open:** (1) compile cost forces a bytecode-precompile step; (2) `Intl` and `WebAssembly` must be supplied; (3) **execution speed is unmeasured and is the real risk**; (4) XP/98 need a sync-layer port.
- **Decision not yet made.** The next measurement (step 2) runs real code: `tsserver.js` under QuickJS against Node on the same project, plus booting the extension-host bundle on a Node shim.

## Caveats

- Compile-only, stub imports, one machine, 2.1 GHz Xeon, QuickJS built with `-O3` (no PGO/LTO tuning).
- The compile times for the workbench varied 2.8 to 3.4 s between invocations; treat them as ±15%.
- The feature probe checks *presence* of properties, not conformance of their behavior.
- Usage counts in the bundle come from regex counting of minified code and may include strings.
