# Spike 12 — Control benchmark: stock Electron VS Code vs the vscode98 host

**Question:** how far is the vscode98 host (QuickJS + own DOM/CSS/layout/paint, no Electron) from stock Electron VS Code on the same machine, per interaction, and where does our time go?

**Answer (2026-10-15, sandbox, both limited to 2 CPUs with `taskset -c 0-1`):** we are **3 to 23 times slower per interaction** and **8 to 18 times slower to start**, while using **20 to 25 % less memory**. In our host, **style computation is 65 to 87 % of every slow interaction**; layout is 5 to 15 %, painting 2 to 5 %, the rest is VS Code's own JavaScript on QuickJS. The owner's observation (stock VS Code 1.70.2 on the same Windows 7 laptop is much faster) is consistent with this.

**Update 2026-10-16 ([spike 13](../13-native-style/README.md)):** with selector matching in C and the computed-value fixes, the same actions take 54 to 394 ms instead of 79 to 981 ms: 2.4 to 8.6 times Electron 1.142 instead of 3 to 23 times. **Later the same day (spike 13 phase 2, a different sandbox machine, Electron re-run there):** 3.0 to 9.2 times Electron 1.142 (phase 1 only on that machine: 3.4 to 14.5 times).

## Re-run 2026-10-17 (v25 code; this sandbox machine, both sides re-measured, 2 CPUs, median of 5 rounds)

After the startup work of packages v18 to v25. Electron 1.70.2 and 1.142 as below. vscode98 is today's tree on Linux (`qjs-spike7`). Its startup is a warm start: a user-data folder with the bytecode cache and the saved style analysis, as on the second start of the package.

| Action | Electron 1.70.2 | Electron 1.142 | vscode98 | / 1.70.2 | / 1.142 | vscode98: style / layout / paint (one round) |
|---|---|---|---|---|---|---|
| Explorer context menu | 44 | 59 | 411 | 9.3 x | 7.0 x | 170 / 68 / 20 |
| Menu bar: open File | 32 | 48 | 266 | 8.3 x | 5.5 x | 116 / 71 / 25 |
| Open file (explorer click) | 81 | 86 | 328 | 4.0 x | 3.8 x | 96 / 68 / 18 |
| Switch to another file | 66 | 86 | 374 | 5.7 x | 4.3 x | 83 / 79 / 19 |
| Click in text: caret moves | 38 | 57 | 274 | 7.2 x | 4.8 x | 62 / 83 / 20 |
| Double click: word selected | 45 | 41 | 211 | 4.7 x | 5.1 x | 29 / 59 / 30 |
| Keystroke to screen | 21 | 25 | 91 | 4.3 x | 3.6 x | 6 / 13 / 19 |
| Quick Open (Ctrl+P) | 48 | 65 | 418 | 8.7 x | 6.4 x | 157 / 147 / 41 |
| Command palette | 101 | 78 | 546 | 5.4 x | 7.0 x | 153 / 131 / 30 |
| New File: input box | 58 | 54 | 185 | 3.2 x | 3.4 x | 63 / 36 / 21 |
| New File: Enter to row | 74 | 89 | 509 | 6.9 x | 5.7 x | 140 / 115 / 59 |
| New Folder: input box | 40 | 39 | 174 | 4.4 x | 4.5 x | 65 / 38 / 25 |
| New Folder: Enter to row | 61 | 51 | 589 | 9.7 x | 11.5 x | 97 / 87 / 64 |
| **Startup to explorer ready** | **2.0 to 2.4 s** | **3.5 to 4.0 s** | **15.1 to 15.8 s** (cold: 22.1 s) | **6.8 x** | **4.1 x** | |
| Memory after 30 s (processes) | 812 to 840 MB (9) | 972 to 977 MB (8) | 439 to 471 MB (6 to 7) | 0.55 x | 0.47 x | |

- Startup: 8 to 10 times Electron 1.142 on 2026-10-15, about 4 times now.
- Interactions: still 3 to 12 times. The rounds since spike 13 worked on startup, not on interactions. Our rounds spread more than Electron's (new folder 309 to 864 ms over the 5 rounds).
- The rest of each interaction (event handling and VS Code's own code on QuickJS) is now as large as style.
- `cdp_page.mjs`: `waitForFunction` waits again when VS Code reloads the window during the wait. The 1.70.2 starts failed with "Execution context was destroyed" without this.

## On the laptop (2026-10-17, owner's stopwatch, second start of each)

| | open | stable |
|---|---|---|
| stock VS Code 1.70.2 (installed) | 4 s | 8 s |
| vscode98 v25 (run 3, profiler off) | 7 s | 15 to 16 s |
| ratio | 1.75 x | about 1.9 to 2 x |

The first stock-VS-Code numbers measured on the owner's laptop. The gap there is much smaller than in this sandbox (6.8 x to explorer ready): 1.70.2 takes about twice as long on the laptop as here, while our host is no slower there than here.

## Contenders

| | Code | Runtime | How it runs here |
|---|---|---|---|
| **Electron 1.142** | this fork's `src/` (unmodified upstream 1.142.0, `32bbe1b8`), bundled by `build_desktop.sh` | Electron 43.7.7 (the binary `npm run electron` downloads) | installed layout: `el-pkg/resources/app` = bundle + the packaged extension set (`package_extensions.mjs`) + real node_modules; Xvfb |
| **Electron 1.70.2** | stock VS Code 1.70.2 (the last release for Windows 7; what the owner's laptop runs) | Electron 18.3.5 / Chromium 100 | the official linux-x64 tarball; `window.titleBarStyle: custom` so menus are HTML as on Windows; Xvfb |
| **vscode98** | the same bundle and extensions as Electron 1.142 | `qjs-spike7` (QuickJS-ng, native layout + rasterizer) | `--layout native --backend native`, headless (no window: paint into a buffer each tick) |

All three use the same seeded settings (AI features off, no minimap/breadcrumbs, custom dialogs; `settings.seed.json`) and the same workspace (`ws98`: a git repo with a few small files).

## Method

The same actions, in the same order, 3 rounds, median reported. Each action is timed **from the input event to the DOM state that shows its result**:
- Electron: `host/electron_lat.mjs` sends real input over the DevTools protocol (`host/cdp_page.mjs`, raw CDP so Chromium 100 works too) and polls the condition every animation frame.
- vscode98: `10-main-shim/host/scenario_ctl.mjs` dispatches the DOM events in-process and runs the window host's tick (timers, frames, style/layout, paint) until the condition holds. `--split 1` records where the time went.
- Startup: `host/electron_start.mjs` / `10-main-shim/host/scenario_start.mjs`: process start until the explorer lists the workspace; memory = RSS of the whole process tree 30 s later.

## Results (ms, median of 3; 2 CPUs)

| Action | Electron 1.70.2 | Electron 1.142 | vscode98 | vscode98 / Electron 1.142 | vscode98: style / layout / paint |
|---|---|---|---|---|---|
| Explorer context menu | 31 | 34 | 779 | 23 x | 649 / 70 / 14 |
| Menu bar: open File | 24 | 25 | 559 | 22 x | 518 / 111 / 16 |
| Menu bar: move to Edit | 21 | 23 | (not reproduced by synthetic events; works with real input) | | |
| Open file (explorer click) | 60 | 61 | 981 | 16 x | 867 / 43 / 13 |
| Switch to another file | 46 | 63 | 358 | 5.7 x | 259 / 58 / 26 |
| Click in text: caret moves | 35 | 45 | 331 | 7.4 x | 217 / 55 / 13 |
| Double click: word selected | 37 | 39 | 106 | 2.7 x | 16 / 33 / 13 |
| Keystroke to screen | 19 | 15 | 79 | 5.3 x | 6 / 8 / 12 |
| Quick Open (Ctrl+P) | 24 | 29 | 379 | 13 x | 221 / 51 / 16 |
| Command palette | 61 | 46 | 635 | 14 x | 338 / 77 / 18 |
| New File: input box | 32 | 40 | 301 | 7.5 x | 220 / 45 / 13 |
| New File: Enter to row | 51 | 43 | 802 | 19 x | 492 / 187 / 53 |
| New Folder: input box | 28 | 25 | 290 | 12 x | |
| New Folder: Enter to row | 38 | 36 | 584 | 16 x | 344 / 87 / 58 |
| **Startup to explorer ready** | **1.5 to 1.8 s** | **2.8 to 3.4 s** | **23 to 32 s** | 8 to 10 x | |
| Memory after 30 s (processes) | 816 MB (9) | 942 MB (8) | ~715 MB (6 to 7) | 0.76 x | |

The per-action style/layout/paint split is one representative round (`--split 1`); the remainder of each action is VS Code's JavaScript (event handlers, services) on QuickJS.

## Reading it

- **1.70.2 vs 1.142 on Electron**: about the same per interaction (Chromium + V8 absorb the bigger code base); 1.70.2 starts about twice as fast. The size of 1.142 is not what makes us slow per interaction.
- **Style is the bottleneck**, not the interpreter: in the slow actions style is 65 to 87 % of our time. Chromium does the same work in a few ms. Our engine restyles at about 0.8 ms per element on this machine (0.45 matching, 0.25 computing, 0.15 the rest), in JavaScript.
- Layout and painting are already native (spike 7) and small.
- What remains after style (the VS Code code itself on an interpreter without JIT) is roughly 2 to 5 times Electron's total; that is the floor without changing the JavaScript engine.
- On the laptop (about 2.5 to 3 x slower than this sandbox for our engine), these numbers match the owner's: menus 1 to 2 s, caret about 1 s, file switch 1.5 s, new file 1.5 s.

## Consequences for the plan

1. **Native style engine** (selector matching, cascade, computed values in C, like `layout.c`), with the JavaScript engine kept as the reference and a verify mode. Expected: the style share drops by an order of magnitude, so the slow actions go from 16 to 23 x to roughly 3 to 6 x Electron.
2. **Startup**: precompiled bytecode for the workbench bundle and the main/utility bundles, and fewer style passes during boot.
3. Re-run this benchmark after each step; the ratios in the table are the progress measure.
4. On the laptop itself, the same comparison against the installed VS Code 1.70.2 will be run with an input-to-pixel timing script that treats both apps alike (not done yet).

## Reproduce

```
# Electron 1.142 (installed layout) and 1.70.2 (tarball), both on Xvfb :99, 2 CPUs
DISPLAY=:99 taskset -c 0-1 el-pkg/code-oss --no-sandbox --disable-gpu --remote-debugging-port=9333 --user-data-dir=ud --extensions-dir=ext ws98 &
node docs98/spikes/12-control/host/electron_lat.mjs 9333 ws98 3
DISPLAY=:99 node docs98/spikes/12-control/host/electron_start.mjs <exe> <ud> <ext> ws98 0-1
# vscode98: runlat.sh in the sandbox (taskset -c 0-1 qjs-spike7 ... boot_desktop_qjs.mjs <app> --scenario scenario_ctl.mjs --split 1)
```
