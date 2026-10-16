# Spike 13 — Native style engine

**Question:** spike 12 showed that style computation is 65 to 87 % of every slow interaction of the vscode98 host. How much of it can move to C, and how much can the JavaScript that stays do better?

**Status (2026-10-16):** phase 1 (selector matching in C) and phase 2 (the computed-value step in C) done, both on by default. Phase 1 plus three JavaScript fixes made interactions 1.6 to 4.4 times faster than in spike 12 (package v15). Phase 2, measured the same day on the same machine, makes them up to 1.8 times faster again (1.0 for a keystroke, which has almost no style work) (context menu 521 → 293 ms, New File 682 → 449 ms, command palette 643 → 460 ms): **3.0 to 9.2 times stock Electron 1.142 on that machine instead of 3.4 to 14.5 times** (see [the phase 2 benchmark](#phase-2-benchmark-same-machine-same-day)). Package v16 carries phase 2.

## Where the style time went (before)

A full restyle of the captured workbench (`run_replay_qjs.mjs /tmp/claude-0/workbench.json --restyle N`: 1016 elements, warm caches, 1 CPU of the sandbox) took **585 ms, 0.58 ms per element**:

| Part | ms | |
|---|---|---|
| Selector matching (`matchedDeclarationsAll`: ~259 index entries considered per element, ~22 full selector matches) | ~270 | phase 1: C |
| Custom properties: every element that declares one copied the ~1500 workbench variables (`new Map(vars)`), and "did inherited values change" walked all of them | ~95 | `VarScope` |
| Layout-change check (`layoutPropsDiffer`: `for...in` over ~200 properties, a `Set` lookup and `deepEqual` each) | ~62 | one pass over a key list |
| Cascade and computed values (`computeStyle`: winners, `var()` substitution, value parsing, ~200 initial values) | ~130 | partly; the rest is phase 2 |

## Phase 1: selector matching in C

Files: `07-native-render/host/style.c` (module `spike:style`), `07-native-render/host/native_style.js` (driver, `env.styleEngine`). Hooks: `06-rendering/host/dom/dom.js` (`setNativeStyleSink`), `css.js` (`index.nat`), `layout.js` (`env.styleEngine`).

- **Atoms.** Tag names, ids, classes, attribute names and selector strings are interned (with their ancestor-filter hashes) once; the JavaScript side keeps a `Map` of the atoms it has seen.
- **Element tree mirror.** Per node: parent, element children, tag (as is and lower case), id, classes, attributes (names as atoms, values as strings), and the flags the matcher cannot get from attributes (hover, active, checked, `:empty`). `dom.js` adds every node it invalidates (`__invalidate`, the same calls that feed the style planner's mutation log) to a set; before each style pass `native_style.js` turns the set into one batch of node records (`sync`): changed elements, the parents of changed text nodes, new subtrees in full. A child that left its parent and was not placed elsewhere in the batch is freed with its subtree; the freed ids come back so the JavaScript nodes forget them.
- **Rule index.** `css.js buildRuleIndex` creates a native index next to each JavaScript one and replays its operations on it: an entry per selector (compiled from the parsed selector of `selectors.js`, flattened to an `Int32Array` cached on the parsed object), the id/class/tag/universal buckets, and the pops and truncation of the in-place update. Native entry ids equal `index.count`, so C returns ids and JavaScript maps them back to the same entry objects.
- **Matcher.** `match(index, node)` walks the same buckets in the same order as `matchedDeclarationsAll` (id, classes, tag, universal; multi-bucket entries once), applies the ancestor Bloom filter (computed from the mirror, cached per pass) and the `:is()` "one of" groups, matches compound by compound (`selectors.js` case by case: combinators, attributes with all operators and the `i` flag, structural pseudo-classes incl. `of S`, `:not/:is/:where/:has`, state pseudo-classes), and returns the element's, `::before`'s and `::after`'s entries in cascade order (stable sort by origin, specificity, order).
- **Verification.** `--style verify` (boot scripts, `run_replay_qjs.mjs`) also runs the JavaScript matcher on every element and records the differences; `09-incremental-style/tests/style_fuzz.mjs` with `FUZZ_NATIVE=1` runs the randomised invalidation test on QuickJS with the native matcher checked the same way.

Matching cost: **~12 ms per full workbench restyle (12 µs per element, ~20 times less than in JavaScript)**; the sync of changed nodes costs ~0.2 ms per pass in the interaction scenarios.

## JavaScript fixes in the computed-value step

- **`VarScope`** (`css.js`): the custom properties of a computed style are the element's own declarations over its parent's scope; elements without custom properties share their parent's scope object. Lookups walk a short chain (flattened past depth 12). Equality compares own entries and parents and remembers the latest equal pair, so the inherited-change check down a restyled subtree no longer walks 1500 entries per element. `var()` substitution results are cached per scope.
- **Cascade:** the winning declaration is stored as is (declarations are applied in cascade order, so a later one wins unless only the earlier one is `!important`); the ~200 values start from one template object (`{ ...INIT_VALUES }`).
- **`layoutPropsDiffer`:** one loop over the precomputed layout-relevant keys, `===` first.

Result: **full workbench restyle 585 → ~130 ms** (native matching), or 585 → ~460 ms with the JavaScript matcher. The layout dump and the painted pixels of the workbench snapshot are identical before and after.

## Interaction benchmark after phase 1 (spike 12's control, same sandbox, 2 CPUs; the 2.1 GHz machine of spike 12)

`10-main-shim/host/scenario_ctl.mjs --rounds 5 --split 1`, median of 5, ms. "Before" is the vscode98 column of [spike 12](../12-control/README.md) (3 rounds, 2026-10-15). "JS matcher" is today's code with `--style js` (it has the computed-value fixes but matches selectors in JavaScript).

| Action | Electron 1.142 | before (spike 12) | JS matcher | **native (default)** | before → native | native / Electron |
|---|---|---|---|---|---|---|
| Explorer context menu | 34 | 779 | 704 | **272** | 2.9 x faster | 8.0 x |
| Menu bar: open File | 25 | 559 | 373 | **199** | 2.8 x | 8.0 x |
| Open file (explorer click) | 61 | 981 | 357 | **223** | 4.4 x | 3.7 x |
| Switch to another file | 63 | 358 | 335 | **224** | 1.6 x | 3.6 x |
| Click in text: caret moves | 45 | 331 | 251 | **186** | 1.8 x | 4.1 x |
| Double click: word selected | 39 | 106 | 91 | **95** | 1.1 x | 2.4 x |
| Keystroke to screen | 15 | 79 | 61 | **54** | 1.5 x | 3.6 x |
| Quick Open (Ctrl+P) | 29 | 379 | 266 | **195** | 1.9 x | 6.7 x |
| Command palette | 46 | 635 | 454 | **394** | 1.6 x | 8.6 x |
| New File: input box | 40 | 301 | 200 | **146** | 2.1 x | 3.7 x |
| New File: Enter to row | 43 | 802 | 569 | **356** | 2.3 x | 8.3 x |
| New Folder: input box | 25 | 290 | 193 | **123** | 2.4 x | 4.9 x |
| New Folder: Enter to row | 36 | 584 | 549 | **259** | 2.3 x | 7.2 x |

Style is now 35 to 70 % of a slow action instead of 65 to 87 % (e.g. context menu: 184 of 271 ms; open file: 100 of 223 ms). The rest is the workbench's own JavaScript (the `event` column: up to 130 ms for opening a menu, ~90 ms for a click in the editor), layout (40 to 80 ms) and paint (12 to 60 ms). Over the run the native matcher served 44803 elements (23 µs each including the conversion back to JavaScript objects) and the node sync 1115 passes (0.17 ms each).

## Phase 2: the computed-value step in C

Files: `07-native-render/host/style_compute.c` (included by `style.c`, same module `spike:style`), `native_style.js` (`engine.compute`). Hooks: `css.js` (`computeStyle` asks `env.styleEngine.compute` first; `computeStyleJS` is the reference; `finishComputed` is shared; `VarScope` and `varsEqual` accept native scopes), `dom.js` (inline style declarations carry a version).

- **What C does per element:** the cascade over the matched rules' declaration blocks and the inline style (the winning declaration per property, `!important` included); the custom properties, in the order they were first declared, into a scope of their own (as `VarScope`: own entries over the parent's scope, flattened past depth 12, equal pairs remembered); `var()` substitution with the semantics of `substituteVars`/`VAR_RE` (leftmost match, fallbacks, nesting depth 10, 50 replacements) and a cache per scope; the global keywords (`initial`, `inherit`, `unset`, `revert`, `revert-layer`); font-size (keywords, `smaller`/`larger`, lengths against the parent) and color first; then every other declared property. JavaScript-compatible `trim()` (ECMAScript white space, not only ASCII).
- **Values stay JavaScript objects.** C keeps a value cache keyed like `parseValueCached` (property, value, and font size and color when the value depends on them); on a miss it calls `css.js parseValue` (and `parseLength`, `parseColor`, `expandShorthand` for a shorthand whose value had `var()`). So a value is, by construction, the object the JavaScript engine would have produced. C writes the values into the `out` object that JavaScript pre-fills with the initial and inherited values; `finishComputed` (border widths, `currentcolor`, font-weight keywords, overflow, blockification, anchor bookkeeping) runs on it in JavaScript.
- **Declaration blocks** are sent once per declaration list (`css.js` caches one per rule) and freed when the list is garbage-collected; an inline style's block is rebuilt only when the declaration's version changes. Custom-property scopes are freed when their JavaScript wrapper (`NativeVars`) is collected.
- **Left to JavaScript:** values with `anchor()`/`anchor-size()` (C returns -2 and `computeStyleJS` runs). A JavaScript `VarScope` parent (from such an element) gets a flat native copy.
- **Modes:** `--style native` (default: both phases), `--style match` (native matching, computed values in JavaScript), `--style js`, `--style verify` (both, every element compared with the JavaScript matcher and with `computeStyleJS`).

Full restyle of the captured workbench (1016 elements, 1 CPU): **~130 → ~80 ms**, of which the computed-value step **~95 → ~36 ms**; layout dump and pixels identical to the engine before phase 1. What is left of the 36 ms is mostly building the ~200-property JavaScript object per element and `finishComputed`; the rest of the 80 ms is the walk (`layoutPropsDiffer`, `inheritedChanged`) and the matcher.

### Phase 2 benchmark (same machine, same day)

The container was moved to a different machine between the phase 1 and phase 2 measurements (a 2.8 GHz Xeon instead of the 2.1 GHz one), and absolute numbers differ between the two (QuickJS ran relatively slower on the new one). So everything below was measured on the new machine on 2026-10-16, back to back: stock Electron 1.142 (re-run, own `HOME`), our host with phase 1 only (`--style match`), and with phases 1 and 2 (`--style native`); 2 CPUs, median of 5 rounds, ms.

| Action | Electron 1.142 | phase 1 (`match`) | **phases 1 + 2 (`native`)** | phase 2 gain | native / Electron | native: style / layout / paint |
|---|---|---|---|---|---|---|
| Explorer context menu | 36 | 521 | **293** | 1.8 x | 8.1 x | 129 / 74 / 26 |
| Menu bar: open File | 36 | 347 | **211** | 1.6 x | 5.9 x | 103 / 72 / 29 |
| Open file (explorer click) | 61 | 331 | **292** | 1.1 x | 4.8 x | 90 / 65 / 16 |
| Switch to another file | 64 | 355 | **295** | 1.2 x | 4.6 x | 109 / 90 / 14 |
| Click in text: caret moves | 68 | 263 | **216** | 1.2 x | 3.2 x | 59 / 70 / 15 |
| Double click: word selected | 39 | 134 | **125** | 1.1 x | 3.2 x | 14 / 42 / 14 |
| Keystroke to screen | 19 | 75 | **75** | 1.0 x | 3.9 x | 5 / 12 / 16 |
| Quick Open (Ctrl+P) | 43 | 300 | **273** | 1.1 x | 6.3 x | 72 / 59 / 20 |
| Command palette | 50 | 643 | **460** | 1.4 x | 9.2 x | 121 / 113 / 23 |
| New File: input box | 47 | 186 | **141** | 1.3 x | 3.0 x | 49 / 28 / 16 |
| New File: Enter to row | 65 | 682 | **449** | 1.5 x | 6.9 x | 113 / 98 / 46 |
| New Folder: input box | 30 | 177 | **125** | 1.4 x | 4.2 x | 54 / 27 / 16 |
| New Folder: Enter to row | 47 | 525 | **397** | 1.3 x | 8.4 x | 84 / 81 / 55 |

Style is now 28 to 45 % of the slower actions (it was 65 to 87 % in spike 12; a keystroke and a double click spend 5 to 14 ms in style). The rest: layout (native, but run on every pass: 30 to 110 ms), the workbench's own JavaScript on QuickJS (the `event` column, ~90 to 125 ms for a menu or a click in the editor), and paint.

## Correctness

| Check | Result |
|---|---|
| `scenario_lat` / `scenario_ctl` with `--style verify` | 0 differences (14997 and 26417 elements matched) |
| The 11 feature scenarios (`inputs explorer search editor settings tour lang misc ui webview more`) with `--style native` | all pass; 0 fallbacks |
| `style_fuzz.mjs` 200 seeds × 25 steps, Node (JavaScript matcher) | 0 mismatching passes |
| `style_fuzz.mjs` on QuickJS, `FUZZ_NATIVE=1` | 0 mismatching passes, 91310 elements, 0 differences from the JavaScript matcher |
| Workbench snapshot: layout dump and pixels, old engine vs new | identical (after phase 1 and after phase 2) |
| Phase 2, workbench snapshot with `--style verify` | 3537 computed styles (elements and pseudo-elements), 0 differences from `computeStyleJS`, 0 left to JavaScript |
| Phase 2, `scenario_lat` on the desktop workbench with `--style verify` | 19531 computed styles, 0 differences, 0 left to JavaScript |
| Phase 2, the 11 feature scenarios with `--style native` (both phases) | all pass (after making `scenario_more`'s SCM check modify `hello.txt` itself: it had relied on an earlier scenario leaving the file modified, and failed the same way with `--style match`) |
| Phase 2, Windows exe under Wine with `--style verify`; `match` vs `native` screenshots | 1500 computed styles, 0 differences; screenshots pixel-identical |
| Phase 2, `style_fuzz.mjs` on QuickJS (`FUZZ_NATIVE=1`, 200 seeds × 25 steps: custom properties, inline styles, inheritance, `::before`, mutations) | 376018 computed styles, 0 differences from `computeStyleJS`, 0 mismatching passes |

Known deliberate differences from the JavaScript matcher: none observed. (The C ancestor filter hashes lower-case tag names on both sides; the JavaScript one hashes `localName` as is for elements and lower case for selectors, which can only make it reject more, e.g. camelCase SVG tags.)

## Found and fixed on the way

- **Linux host exits with code 0 under load.** QuickJS-ng's `js_os_poll` returns -1 when `poll()` is interrupted by a signal (`EINTR`), and `js_std_loop` then ends: `child_process.js` listens for `SIGCHLD`, so a child exiting at the wrong moment ended the main process. This was the flaky "main process exited: code 0" of earlier benchmark runs (1 run in 2 on 2 CPUs). `07-native-render/host/build.sh` now compiles a patched `quickjs-libc.c` that polls again. (The Windows host has its own wait loop and was not affected.)
- **Exceptions in timers and microtasks** (`02-node-shim/host/globals.js`): an exception thrown by a `setTimeout`/`setInterval` callback, `queueMicrotask` or `process.nextTick` job ended QuickJS's event loop; Node gives it to the `uncaughtException` listeners (VS Code's processes all have one) and goes on. Now routed the same way.
- **sqlite3 stand-in** (`10-main-shim/host/native_addons98.js`): `sqlite3.js` copies `EventEmitter.prototype` onto the binding's classes with `for...in`, which sees none of the methods of our class-based EventEmitter, so `Statement#on` was missing and every storage transaction threw. The stand-in classes now extend EventEmitter.
- `scenario_ctl.mjs`: Escape until no menu is open (a File menu left open under the explorer took the next click on a row: its Exit item quit the app), short timeout for the menu-move step that synthetic events do not reproduce.

## Next

- **Phase 3:** let the native layout read the computed values from C directly (today `layout_pack.js` reads them back from the JavaScript objects and packs them into typed arrays), and skip building the ~200-property object for elements whose values nobody reads in JavaScript; move `finishComputed` and the layout-change check (`layoutPropsDiffer`) to C with them.
- **Layout per pass** is now as large as style in many actions (30 to 110 ms): it runs over the whole tree on every pass that is not style-only; incremental layout (relayout only dirty subtrees) is the next big lever after style.
- **The first style pass at startup** is ~2.5 s for the workbench, almost all of it the rule index (13296 rules): stylesheet parsing ~0.55 s, selector parsing ~0.4 to 0.7 s, declaration expansion ~0.2 s, invalidation analysis ~0.5 s, native entries ~0.2 to 0.3 s. On the laptop (v16, round 11) that first pass took 5001 ms, 4855 ms of it the index, a quarter of the 20 s launch; re-profiled on the replay 2026-10-16: parsing the 2 MB `workbench.css` alone 479 ms, selector parsing 514 ms, declaration expansion 249 ms, the rest of the per-rule preparation 256 ms, native entries 288 ms. The next startup target: a CSS/selector parser in C, a cached prebuilt index, or deferring per-rule work (declaration expansion, ancestor-filter bits) until a rule is first a candidate.
- The workbench's own JavaScript per action (`event` column) and layout are now a larger share; menus spend ~100 to 130 ms in event handling before any style work.
