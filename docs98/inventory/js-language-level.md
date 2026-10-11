# Inventory — JavaScript Language Level

Taken at `32bbe1b8`. Source: `src/tsconfig.base.json`, `build/next/*.ts`, `scripts/scan_web_and_lang.sh`.

## Configured targets

| Setting | Value |
|---|---|
| TypeScript `target` (src, monaco, extensions) | `ES2024` |
| esbuild targets (`build/next/bundle.ts`, `transpile.ts`, etc.) | `es2024` |
| TypeScript `module` / `moduleResolution` | `nodenext` (source) |
| Modules at runtime | ESM in the new build (`build/next`), CommonJS for extensions |

So the build currently emits **modern JS with no downleveling**, on the assumption of Chromium/Node 24.

## Language feature usage (files, non-test; over-approximate)

| Feature | Files | Notes |
|---|---|---|
| `async`/`await` | 2808 | Ubiquitous |
| Optional chaining `?.` | 3186 | Ubiquitous |
| Nullish `??` | 2323 | Ubiquitous |
| Decorators (`@`) | 2631 | Mostly the DI parameter decorators (TypeScript, compiled away or lowered by the toolchain) |
| `Array` methods `.at/.findLast/.toSorted/.flatMap/.fromEntries` | 501 | ES2019–ES2023 |
| `WeakMap`/`WeakSet` | 107 | |
| Dynamic `import()` | 100 | Needs async module loading in the engine |
| Regex named groups | 97 | |
| `Promise.allSettled/any/withResolvers` | 64 | `withResolvers` is ES2024 |
| `Symbol.*` | 58 | |
| Generators | 48 | |
| `for await` | 47 | Async iterators |
| Regex `u`/`v` flag | 28 | |
| Private class fields `#x` | 23 | |
| `BigInt` | 17 | |
| Regex lookbehind | 13 | |
| `Reflect` | 14 | |
| `Proxy` | 12 | |
| `Intl.Segmenter` | 4 | Needs Unicode segmentation data |
| Top-level `await` | 0 | |
| `Object.groupBy`/`Map.groupBy` | 0 | |
| Explicit resource management (`using`) | 1 | |

## Implications for the JS engine choice (D-004)

- **Required engine capabilities**: async/await, generators + async generators, optional chaining/nullish, private fields, `Proxy`/`Reflect`, `WeakRef`, regex lookbehind/named groups/unicode flags, `BigInt`, dynamic `import()`, `Intl`-class features, typed arrays, typed `TextDecoder`, `Promise.withResolvers` (or polyfill).
- Because the build already uses esbuild, a **downlevel target** (e.g. `es2020`) is plausible, but esbuild cannot lower everything (notably some regex features and `Intl`). Determine exactly which features block a target in the Phase 1 spike.
- Whether QuickJS-ng (or another candidate) supports the above is **(unverified)**; confirm by running the compiled workbench bundle or Test262 results.
- **Performance** is the open risk, not conformance. VS Code's startup executes a lot of JS; a bytecode interpreter will be much slower than V8's JIT. Measure in Phase 1.
- Intl/Unicode data (`Intl.Segmenter`, `Intl.Collator`, `normalize`, `localeCompare` in ~190 files) means the engine needs ICU-like data or substitutes.

## To verify

- Actual compiled output of the workbench (no `out/` exists yet; needs `npm ci` and a build) — to measure bundle size and check the truly emitted syntax.
- Which features come from third-party deps (e.g. `@xterm/xterm`, `vscode-textmate`) rather than `src/vs`.
