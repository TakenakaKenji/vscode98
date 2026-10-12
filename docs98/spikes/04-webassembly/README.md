# Spike 4 — WebAssembly on QuickJS

**Question:** syntax highlighting (TextMate via `vscode-oniguruma`) and tree-sitter ship as WebAssembly, and QuickJS-ng has no `WebAssembly`. What do we do?

**Short answer:** all three routes tried give byte-identical results. For Oniguruma, **do not use a WASM interpreter**: link the regex engine natively (or translate `onig.wasm` to C with wasm2c). A wasm3 interpreter works but makes tokenization about 2.6× slower than native on the same machine (64-bit; 4.9× in a 32-bit build). Tree-sitter is not on the critical path (it is behind experimental settings that default to off) and was **not** shown to run on wasm3.

Scope: this is a feasibility spike on Linux (x86-64, plus an x86 32-bit build). Nothing here was built or run on Windows.

## What was built (`host/`)

One host binary, `qjs-spike4` = stock QuickJS-ng 0.17.0 `qjs.c` with one added line (`spike_init(ctx)`), plus:

| Piece | File | What it is |
|---|---|---|
| `WebAssembly` JS API on wasm3 (commit `28ecb9a`) | `wasm3_js.c` | `Module`, `Instance`, `Memory` (`buffer` aliasing wasm memory, detached on grow), `Table` (`length`/`get`), `RuntimeError`/`CompileError`/`LinkError`, `validate`/`compile`/`instantiate`. Imports are marshalled through raw trampolines; JS exceptions propagate through wasm frames. |
| Native Oniguruma | `onig_native.c` | C port of `vscode-oniguruma`'s `onig.cc` (regset search for strings under 1000 bytes, cached per-regex search otherwise, `\G` not cached) over libonig 6.9.8 (commit `08d3611`, the one `vscode-oniguruma` 1.7.0 pins). |
| `onig.wasm` via wasm2c | `onig_w2c.c` + generated `onig.c` | `onig.wasm` translated to C (wabt 1.0.34) with the same JS surface. Traps via `wasm_rt_impl_try()`. |
| Shared JS classes | `onig_js.c` | `OnigString`/`OnigScanner` with the UTF-16↔UTF-8 offset maps and the unsigned-offset quirk of the real wrapper (unmatched captures). Registers `spike:onig-native` and `spike:onig-wasm2c`. |
| Build | `build.sh` | `bash build.sh <outDir>`; `M32=1` for a 32-bit build (needs `build32` library dirs); `W2C_DEFS=-DWASM_RT_USE_MMAP=0` for the bounds-checked memory model. |

The real, unmodified `vscode-oniguruma` JS wrapper plus real `vscode-textmate` run unchanged on the wasm3 route (`new WebAssembly.Instance` only). The native and wasm2c routes replace the wrapper with the C module.

## Tests (`tests/`)

- `smoke_webassembly.js` (+`smoke.wat`): memory aliasing and detach on grow, traps, JS exception through wasm, missing import.
- `onig_smoke.mjs`: same output under Node (V8) and wasm3.
- `tokenize_bench.mjs`: tokenizes 8,482 lines of three real TypeScript files from this repo (303,638 chars) with the real TextMate TypeScript grammar. All implementations produce 71,782 tokens with the same hash `628c6f1d`, as does Node.
- `replay_bench.mjs`: replays the 68,741 `findNextMatchSync` calls recorded from that run and checks **every** result (index and all capture offsets) against the recording. `edge-trace.json` (16,632 calls from `make_edge_trace.mjs`) adds Unicode, long lines (the ≥1000-byte cache path), `\G` and unmatched-capture cases. **0 mismatches, 0 scanner-creation errors on every implementation and build.**

## Results (single runs, noisy, ±10 to 20 %)

Per `findNextMatchSync` call (µs, inside the call only), replay of the 68,741-call trace:

| Implementation | x86-64 | x86 32-bit |
|---|---|---|
| Node 24 / V8 (`onig.wasm`) | 10.2 | n/a |
| wasm3 interpreter (`onig.wasm`) | 81 | 188 |
| native libonig | 12.2 | 14.3 |
| wasm2c (`onig.wasm` as C), mmap guard pages | 13.8 | n/a |
| wasm2c, bounds-checked memory (`WASM_RT_USE_MMAP=0`) | 15.4 | 23.2 (32-bit always uses bounds checks) |

End to end tokenization of the 8,482 lines (seconds):

| Implementation | x86-64 | x86 32-bit |
|---|---|---|
| Node 24 / V8 | 1.40 | n/a |
| QuickJS + wasm3 | 12.05 | 24.1 |
| QuickJS + native libonig | 4.59 | 4.92 |
| QuickJS + wasm2c | 4.05 | 6.30 |

Reading:

- Regex matching is not the whole cost. Even with native Oniguruma, tokenization on QuickJS is ~3.3× slower than on V8 (4.6 s vs 1.4 s), because the rest of `vscode-textmate` runs on the interpreter (consistent with spike 2's 8.5× on pure compute, diluted by the work now done in C).
- wasm3 costs about 8× per call versus V8 on x86-64, which more than doubles tokenization versus native. On 32-bit wasm3 is a further ~2.3× slower (it is built around 64-bit slots), so on the real XP/98-class targets this route would be the worst.
- wasm2c with mmap and native are within ~15 % of V8's per-call speed. Bounds-checked wasm2c costs ~12 % more on 64-bit and ~60 % more than native on the 32-bit run.
- Binary size: `qjs-spike4` is 3.1 MB (x86-64) and 3.6 MB (x86-32, bounds-checked wasm2c) including all three routes; the wasm2c object for `onig.wasm` (466 KB wasm) is 0.7 MB with guard pages, 0.9 to 1.0 MB bounds-checked. The generated `onig.c` is 4.4 MB of source (not committed; regenerate with `build.sh`).
- RSS was not usefully measured (dominated by the 13.7 MB trace JSON).

## Caveats

- The 32-bit binary is ILP32 on a 64-bit Linux kernel. It says nothing about Windows APIs, the XP/98 C runtime or 2 GB address-space pressure. wasm2c's default mmap memory model reserves a multi-GB guard region, which cannot work on 32-bit or Win9x; the bounds-checked mode is the only one that applies there and does not use signal handlers or `mmap`.
- Native libonig must be built for each target. Oniguruma is plain C89-style code and built here with CMake/gcc; building with an XP/98-capable toolchain was not tried.
- wasm3's Windows support (MSVC, Win32 host files) exists in its sources, but wasm3 was not built for Windows here, and its dispatch relies on compiler tail-call behaviour that was not checked on old toolchains.
- The JS `WebAssembly` API here implements only what Emscripten-style `instantiate(bytes, imports)` needs. **No `new WebAssembly.Memory/Table/Global`, no imported memories/tables/globals, no table `set`/`grow`, no shared memory, no exceptions.**
- The test traces come from TypeScript files only. Other grammars were not exercised beyond `make_edge_trace.mjs`.
- Behavioural equivalence is established for the recorded calls only, not proven for all regexes.

## Tree-sitter

- `@vscode/tree-sitter-wasm` 0.3.1 is Emscripten dynamic-linking output: the runtime (`tree-sitter.wasm`, 206 KB) and each grammar (`tree-sitter-*.wasm`, 5 KB to 5.4 MB) import one shared `env.memory` and one shared `env.__indirect_function_table`, plus `__memory_base`/`__table_base` globals, and are linked at runtime by the Emscripten JS loader.
- `tests/treesitter_probe.mjs` instantiates the runtime and one grammar with hand-made imports under Node (works) and under `qjs-spike4` (**fails**: the spike's `WebAssembly` has no `Memory`/`Table`/`Global` constructors). This is a gap in my JS API, not a verdict on wasm3. wasm3's own source has module-to-module linking of imported memories and tables (`m3_env.c`, "repoints an imported slot at the memory or table the exporting module owns"), but that was not tested and the dylink relocation step would still need work.
- Usage in the tree: `editor.experimental.treeSitterTelemetry` and `editor.experimental.preferTreeSitter.{css,typescript,ini,regex}` are all `default: false`/experimental; the other consumers are terminal-chat command parsing (agent features, scoped out by D-008) and an inspect-tokens helper. So the default editor does not need tree-sitter.
- If tree-sitter is wanted later, the two plausible routes are (a) static-link the runtime and the grammars with wasm2c (it supports importing a shared memory/table), or (b) build tree-sitter's C library and grammars natively (grammar C sources are not in `node_modules`). Neither was tried.

## Findings that change the plan

1. **WebAssembly does not need to be a general feature of the host to get syntax highlighting.** Oniguruma can be provided as a native module with the `OnigScanner`/`OnigString` surface, behind the import of `vscode-oniguruma` (a shim like the ones in spike 2/3). A wasm2c translation of the shipped `onig.wasm` is an equal-speed alternative that needs no Oniguruma source and tracks upstream's exact binary.
2. A generic `WebAssembly` is only needed for other WASM consumers in the tree. Not surveyed beyond `vscode-oniguruma` and tree-sitter. Extensions may ship their own `.wasm` (not surveyed).
3. With either native route the TextMate engine's remaining cost is JavaScript on QuickJS; tokenization of a 2,700-line file is ~1.5 s (est. from the totals above, not separately timed), which is the number that matters for D-004.

## Reproduce

```
bash docs98/spikes/04-webassembly/host/build.sh /tmp/spike4                 # x86-64
M32=1 bash docs98/spikes/04-webassembly/host/build.sh /tmp/spike4-32        # needs 32-bit libs in build32/ dirs
/tmp/spike4/qjs-spike4 docs98/spikes/04-webassembly/tests/replay_bench.mjs --impl wasm|native|wasm2c
node docs98/spikes/04-webassembly/tests/replay_bench.mjs --impl wasm       # V8 reference
```

Prerequisites (not in the repo): QuickJS-ng 0.17.0 (`9b06171`), wasm3 `28ecb9a`, Oniguruma 6.9.8 (`08d3611`), wabt 1.0.34 (`apt install wabt`), `npm ci` for `vscode-oniguruma`, `vscode-textmate`, `@vscode/tree-sitter-wasm`. The 13.7 MB trace is regenerated with `tokenize_bench.mjs --record`.
