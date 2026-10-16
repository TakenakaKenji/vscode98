# Spike 13 — Native style engine

**Question:** spike 12 showed that style computation is 65 to 87 % of every slow interaction of the vscode98 host. How much of it can move to C, and how much can the JavaScript that stays do better?

**Status (2026-10-16):** phase 1 done (selector matching in C, on by default), plus three JavaScript fixes in the computed-value step found by profiling. Phase 2 (computed values in C) not started.

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

## Correctness

| Check | Result |
|---|---|
| `scenario_lat` / `scenario_ctl` with `--style verify` | 0 differences (14997 and 26417 elements matched) |
| Feature scenarios (`scenario_*`, `--style verify` / `native`) | see below |
| `style_fuzz.mjs` 200 seeds × 25 steps, Node (JavaScript matcher) | 0 mismatching passes |
| `style_fuzz.mjs` on QuickJS, `FUZZ_NATIVE=1` | 0 mismatching passes, 91310 elements, 0 differences from the JavaScript matcher |
| Workbench snapshot: layout dump and pixels, old engine vs new | identical |

Known deliberate differences from the JavaScript matcher: none observed. (The C ancestor filter hashes lower-case tag names on both sides; the JavaScript one hashes `localName` as is for elements and lower case for selectors, which can only make it reject more, e.g. camelCase SVG tags.)

## Found and fixed on the way

- **Linux host exits with code 0 under load.** QuickJS-ng's `js_os_poll` returns -1 when `poll()` is interrupted by a signal (`EINTR`), and `js_std_loop` then ends: `child_process.js` listens for `SIGCHLD`, so a child exiting at the wrong moment ended the main process. This was the flaky "main process exited: code 0" of earlier benchmark runs (1 run in 2 on 2 CPUs). `07-native-render/host/build.sh` now compiles a patched `quickjs-libc.c` that polls again. (The Windows host has its own wait loop and was not affected.)
- **Exceptions in timers and microtasks** (`02-node-shim/host/globals.js`): an exception thrown by a `setTimeout`/`setInterval` callback, `queueMicrotask` or `process.nextTick` job ended QuickJS's event loop; Node gives it to the `uncaughtException` listeners (VS Code's processes all have one) and goes on. Now routed the same way.
- **sqlite3 stand-in** (`10-main-shim/host/native_addons98.js`): `sqlite3.js` copies `EventEmitter.prototype` onto the binding's classes with `for...in`, which sees none of the methods of our class-based EventEmitter, so `Statement#on` was missing and every storage transaction threw. The stand-in classes now extend EventEmitter.
- `scenario_ctl.mjs`: Escape until no menu is open (a File menu left open under the explorer took the next click on a row: its Exit item quit the app), short timeout for the menu-move step that synthetic events do not reproduce.

## Next

- **Phase 2:** the computed-value step (`computeStyle`, ~100 ms of the remaining ~130 ms per full restyle) in C, feeding the native layout directly instead of building ~200-property JavaScript objects.
- **The first style pass at startup** is ~2.5 s for the 1016-element workbench (index build, declaration expansion and value parsing with cold caches): the next startup target.
