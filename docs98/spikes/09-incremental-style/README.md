# Spike 9 — incremental style invalidation

**Question** (spike 8's main finding): the real workbench reads layout after almost every DOM change, and our engine answered each read with a full restyle of the whole tree. Boot cost 131 passes × ~1.3 s, one keystroke ~10 s. A perfect invalidation needs ~4 % of those restyles. Can the style pass be made incremental, **without ever returning a different result than a full restyle**?

- **Host:** same as spike 8 (`qjs-spike7`, QuickJS-ng 0.17.0 x86-64, native layout + integer rasterizer; Intel Xeon @ 2.1 GHz, 4 vCPU). The planner is plain JS in the spike 6 engine; nothing native was added.
- **Code** (all in spike 6's `host/dom/`): `style_invalidation.js` (new: analysis of the rule set, planner, rule-set delta), `layout.js` (`resolveStyles` now an incremental driver, `verifyStyles` oracle), `css.js` (cached candidates), `dom.js` (richer mutation log). Tests and tools: `tests/style_fuzz.mjs` (this directory), `--verify 1` and `--detail 1|2` of the spike 8 harness.

## Verdict

1. **Yes, and the result is exact as far as we can test it.** Workbench boot: **175 s → 32 s** (style 165 s → 21.5 s). Typing one character into a Monaco editor: **~10 s → ~0.1 s** (4 layout passes, 36 ms style + 78 ms native layout). Opening the command palette: 25.8 s → 4.7 s. Escape: 5.3 s → 0.6 s. Clicking Search in the activity bar: 119.8 s → 5.9 s. Everything on the same machine, same bundle, same scenario script as spike 8.
2. **Soundness is checked two ways.** (a) A verify mode re-runs a *full* restyle (ancestor filter off, so it also checks the Bloom filter) after every incremental pass and compares computed values, custom properties and pseudo-element boxes of every element: **0 mismatches over a complete boot of the real workbench** (see Results for the final run). (b) A fuzzer (`tests/style_fuzz.mjs`) builds random trees and random rule sets from ~100 selector shapes (descendant/child/`+`/`~`, `:not/:is`, `:has`, structural pseudos, `:focus`, `:focus-within`, `:empty`, `*`, attribute selectors, `nth-child(n of S)`), applies random mutations (attribute, class, insert/remove/move, style sheets added/removed/moved, focus, text) and verifies after every pass: **650,000 passes with 0 mismatches** on the final code (numbers below), after the fuzzer (and, for one, a code read) had found and we had fixed 15 distinct soundness bugs (list below).
3. **The remaining cost is no longer the number of restyles but their price and the fixed price of a pass.** Boot restyles 6,786 of 128,207 element-passes (5.3 %; ideal 3.6 %, i.e. 4,675), 4,845 of them needing a rematch of the rules. An element restyle still costs ~2 to 4 ms on QuickJS (rule matching), a stylesheet change rebuilds the rule index (0.5 to 2.3 s, see below), and two full passes still cost 3.9 s. Memory did not improve: RSS peak 607 MB (the per-pass garbage of spike 8 was not the cause, or not the only one).
4. **What this changes for the plan:** D-003 (own DOM/CSS/layout engine) lost its biggest risk. The command palette at 4.7 s and a Search click at 5.9 s are still too slow for the target hardware (and this machine is probably 10 to 30 times faster than a K7), but the per-keystroke cost is now dominated by layout (70 ms) rather than style, so the next targets are visible: selector matching speed (native matcher), the rule-index rebuild on sheet changes, and memory.

## Design

Every layout pass hands the *mutation log since the last pass* to `resolveStyles`. The log (`dom.js`, `__invalidate`) records insertions/removals (with the child index), attribute changes (with the old value), text changes and state changes (focus). `planRestyle` turns it into **marks**:

| Level | Meaning |
|---|---|
| 3 SUBTREE | re-match this element and every descendant (it is context for a descendant/child selector, or it is new) |
| 2 SELF | re-match this element; descendants are recomputed only if an inherited value or custom property of it changed |
| 1 INHERIT | recompute from the cached matched rules (the walk does this when a parent's inherited value changed) |

The walk (`resolveStyles`) visits only the marked elements and their ancestors, rebuilds the ancestor Bloom filter along that path, re-matches or recomputes as marked, **compares the new computed style with the cached one and stops propagating when nothing inheritable changed**. Cached per element: computed style, matched rule candidates (`__cands`, `__pcands` for `::before/::after`), Bloom filter, previous element sibling.

What decides the level is a one-time analysis of the active rule set (`analyzeIndex`, redone only when the rule set changes):

- **Keys** (class, id, attribute names, state pseudo-classes) that occur as *ancestor context* (`ctxKeys`), as *sibling context* (`sibKeys`, `sibKeysDeep` when something follows that depends on the sibling's descendants), inside `:has()` (rule list with host compound), in `:nth-child(n of S)` lists (`sibAllKeys`), and which structural pseudo-classes exist (first/last/nth/nthLast/empty, with a `left` flag when the compound is not the rule's subject). A mutation only matters through keys that are used in the matching role, so toggling a class that only appears in the subject compound costs one element.
- **Shapes.** A key alone is too coarse for the workbench: `:focus-within` and `:last-child` occur in ~100 and ~25 rules, so a focus change would have re-matched all ancestors' subtrees. Every state/structural key therefore carries the *shape* of the compounds it appears in: tag, id, classes, attribute names, the `:is()` alternatives, plus a required parent (after `>`) or required ancestor (after a descendant combinator). Only elements that can satisfy a shape are marked at level 3 for that key; the rest get level 2. This took boot from 11,341 to 6,786 element restyles and a keystroke from 1,794 to ~14.
- **Position-aware structure.** For an insertion or removal only the elements whose first/last/nth status can have changed are marked (the edge element, the inserted ones next to it, the first untouched one behind them; for `nth` only those at or after the changed index; for `A + B` the elements whose previous element sibling differs from the cached one).
- **Focus** compares the focus chain (active element + ancestors) of the previous style pass with the current one; the log cannot say where a removed element used to be.
- **Rule-set changes** (a `<style>`/`<link>` inserted, removed, edited, `adoptedStyleSheets`): `diffIndex` finds the rules added/removed (null, i.e. full restyle, if >3000 changed or if the relative order of the other rules changed), `matchesDelta` marks the elements the changed rules can match (level 2), and the analysis of the *old and new* rule sets are merged so mutations in the same window are planned against both.
- **Fallback to a full restyle** when the log overflowed, the environment (viewport, fonts) changed, the first pass, or more than 40 % of the elements would be marked.

## Soundness bugs the fuzzer found (all fixed)

1. Focused element removed from the DOM: stale `:focus` style (log cannot say where it was) → focus-chain diff.
2. Rule removed in the same window as an attribute change (analysis of the new rules only) → merged analyses of old and new rule sets.
3. A moved stylesheet changes the cascade order of unchanged rules → `diffIndex` checks the relative order.
4. Blurred, then removed, focused element.
5. `div:empty + .x`, `li:first-child + x`: structural pseudo-classes on the left of a sibling combinator did not mark the following siblings.
6. `.a:not(.b) + .c`, `:is(.a, .b) ~ .c`, `.a:has(.b) + .c`: keys and `:has()` hosts nested in the left compound of a sibling combinator were treated as ancestor context only.
7. `A + B` with an element inserted *between* them: B's previous sibling changed but the inserted element had none of A's keys → cached previous sibling is now compared.
8. `:last-child` after *several* insertions at the end (the old last child is not among the last two) → walk back over the inserted ones.
9. `nth-child(n of S)`: a sibling gaining or losing the class used in S changes the position of siblings before and after it.
10. `:has()` over a subtree that had a child removed earlier in the same window (the keys of what was removed from inside a removed subtree were lost) → closure over earlier removals, with a cycle guard.
11. The ancestor Bloom filter of an unchanged ancestor can predate a class change that no rule cared about at the time; a rule added later then failed to match through it → filters on the walked path are rebuilt.
12. The closure in 10 followed cycles (a node removed from A, A later appended into that node's subtree) and overflowed the stack.
13. Latent, found while reading rather than by the fuzzer: the sibling-context block stopped at the first inserted element that triggered it, so a second inserted element that needed a deeper level (3 instead of 2) was lost.
14. A removed element mattered with its *old* attributes (`:has(.c)` hosts above it, sibling keys); an attribute change and a removal in the same window used only the new class list.
15. The focused element moved with its parent (the node is the same, its ancestors are not): the focus-chain diff only ran when the active element itself changed.

Not a soundness bug but worth knowing: the fuzzer's random trees can make the flex layout take minutes (a nested-flex blow-up in `layoutFlex`, seed 20535 with `--prof`); the fuzzer now replaces layout with a no-op so it checks style only. That blow-up is a layout-engine performance bug that real pages could hit too.

## Results

Workbench boot (`boot_qjs.mjs --layout native --backend native`, no verification; the run is timing dependent: 131 passes before, 163 now because the faster boot interleaves timers differently, so compare per-pass numbers as well):

| | Spike 8 | Spike 9 |
|---|---|---|
| Time until the DOM stops changing | 175 s | **32.2 s** |
| Layout passes | 131 | 163 |
| Style time (all passes) | 164.9 s | **21.5 s** (incremental passes 17.5 s, 2 full passes 3.9 s) |
| Native layout | 3.7 s | 3.7 s |
| Element restyles | 97,245 | **6,786** of 128,207 (ideal 4,675) |
| Rule matchings redone | = restyles | 4,845 |
| Peak RSS | 666 to 683 MB | 607 MB |

Interaction (`host/scenario_basic.mjs`, element restyles are *done* restyles, "ideal" is the lower bound estimate of spike 8):

| Action | Spike 8 | Spike 9 |
|---|---|---|
| type one character (typical) | 6 passes, 8.6 to 10.7 s, 5,535 restyles | **4 passes, ~0.1 s (style 36 ms, layout 78 ms), 14 to 16 restyles** (ideal 14 to 16) |
| first character | 10 passes, 15.7 s | 1.5 s (includes the onboarding dialog going away, 408 restyles) |
| F1 (command palette, 1,421 elements) | 14 passes, 25.8 s | 15 passes, 4.7 s, 1,034 restyles (ideal 793) |
| Escape | 2 passes, 5.3 s | 2 passes, 0.6 s, 377 restyles |
| click Search in the activity bar | 49 passes, 119.8 s | 49 passes, **5.9 s**, 2,280 restyles (ideal 2,065) |

Note: in this run the harness's "close the onboarding dialog" and "Ctrl+N" steps report 0 passes because the dialog closes on a timer after the (now much earlier) end of the boot; its removal lands in the first typed character. The text still arrives in the editor (`"const x"`).

Verification: see "Verified runs" below.

### Verified runs

- Fuzzer, final planner code: 4 ranges × 4,000 seeds × 25 steps (400,000 passes, seeds from 600000, 700000, 800000, 900000) and 5 selector-restricted pools (`FUZZ_SEL`: `has`, sibling combinators, structural, `focus`, `:is/:not`) × 2,000 seeds (250,000 passes): **0 mismatches in 650,000 passes**. The fuzzer is not run in CI; reproduce with `node tests/style_fuzz.mjs 4000 25 600000`. Earlier ranges (about 700,000 further passes, on earlier versions of the planner) found the bugs above.
- Workbench boot with `--verify 1`: see `results/boot-verified.txt` and `results/scenario-verified.txt` (final code): 163 passes, **0 mismatches** over boot and over the scenario.

## Limitations and open items

- Not handled incrementally (they fall back to a full restyle or are unsupported): relative `:has()` arguments the selector parser cannot parse (8 "unparsable selector" warnings in the workbench), property-based state that does not go through the log (`input.checked = ...`, `details.open`), `:hover`/`:active` (the harness never produces them), media-query or viewport changes, and more than 40 % of the tree being dirty. `matchesDelta` evaluates changed rules against every connected element.
- Relative `:has()` arguments (`:has(> x)`, `:has(+ x)`, `:has(~ x)`) are not supported by the spike 6 selector parser at all (the rule is dropped like any unparsable selector, so this spike neither plans nor fuzzes them). VS Code's CSS uses them. When the parser learns them, `:has(+ x)` / `:has(~ x)` hosts are *previous siblings* of the changed element and the planner (`touchHas` walks ancestors only) must be extended.
- A rule-index rebuild on a stylesheet change costs 0.5 to 2.3 s on QuickJS (the first pass builds the index of ~17,000 rules). Many passes in the boot insert `<style>` elements (Monaco injects them per editor). Incremental index maintenance (add/remove rules instead of rebuilding) is the obvious next step.
- Matching is still ~2 to 4 ms per element on QuickJS; a native selector matcher is the next speed step after that. Neither was started.
- Memory is unchanged (607 MB peak) and is its own problem.
- `display: grid` (124 uses) and floats (349) are still unsupported by the layout engine (spike 8).
- Nothing here ran on Windows.

## Files

- `../06-rendering/host/dom/style_invalidation.js` — analysis, planner, rule-set delta
- `../06-rendering/host/dom/layout.js` — `resolveStyles` (incremental driver), `verifyStyles`
- `../06-rendering/host/dom/dom.js`, `env.js`, `css.js` — mutation log, pass summaries, cached candidates
- `tests/style_fuzz.mjs` — `node style_fuzz.mjs [seeds=200] [steps=25] [firstSeed=1]`; `FUZZ_SEL=<regex>` restricts the selector pool, `FUZZ_DEBUG=1` dumps marks, reasons and the tree at a mismatch
- Spike 8 harness options: `--verify 1` (compare every pass with a full restyle), `--incremental 0` (force full restyles), `--detail 1|2` (per-pass lines / large level-3 marks with the reason)
