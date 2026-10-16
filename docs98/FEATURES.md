# Feature status (Windows host, QuickJS, own DOM/renderer)

What works, how it is tested, and what is known broken. "Scenario" = a headless script in `spikes/10-main-shim/host/scenario_*.mjs` that drives the booted workbench through the **same input driver as the native window** (`spikes/06-rendering/host/dom/input_driver.js`) and checks the DOM; run with `/tmp/claude-0/runsc.sh <scenario> [secs]` on the dev sandbox (see the spike 11 README for the Wine and VM flow). "VM" = confirmed by the owner on a real Windows 7 VM. Update this table whenever a feature is fixed or found broken.

Status: ✅ works in a scenario (and Wine where noted), 🟡 partly, ❌ broken, ⬜ not tested yet.

| Area | Feature | Status | Test / notes |
|---|---|---|---|
| Text boxes | Typing, caret, selection (mouse, keyboard), clipboard, undo/redo, placeholder in every `<input>`/`<textarea>` (quick open, find, settings search, SCM message, rename) | ✅ | `scenario_inputs`; VM confirmation pending (v11) |
| Explorer | New File, New Folder, rename, delete (to the recycle bin on Windows), context menu, Reveal in File Explorer | ✅ | `scenario_explorer` (Linux); Wine: new file/folder in 0.3 to 0.4 s since the pipe write-queue fix (v14); before, they waited for the next IPC message (laptop: 15 to 20 s or never) |
| Search | Find in Files (ripgrep 13.0.0 i686), results tree, replace in files | ✅ | `scenario_search`; `rg.exe` on Win7 pending (v11) |
| Editor | Typing, undo/redo, cut/copy/paste, find, replace (Ctrl+H, replace all), save, dirty marker, wheel scroll, click to place the caret | ✅ | `scenario_editor`, `scenario_misc` (`--only caret`: the caret went to the end of the line before v14) |
| Editor | Context menu (right click, Shift+F10 / Menu key) | ✅ | `scenario_misc --only context`; needs `editor.useShadowDOM: false` (seeded) |
| Editor | Completion, hover, diagnostics (JavaScript via the TS server on QuickJS) | ✅ | `scenario_lang` |
| Tabs | Switch, close button (a dirty tab prompts to save), several tabs | ✅ | `scenario_misc` |
| Command palette, Quick Open | Open, filter, run | ✅ | `scenario_tour`; VM: F1 0.5 to 1 s |
| Menus | Menu bar dropdowns, keyboard | ✅ | `scenario_tour`; VM (v10) |
| Settings editor | Search, text/number/dropdown/checkbox settings | ✅ | `scenario_settings` |
| Source control | Changes list, stage, commit message, commit (real `git`) | ✅ | `scenario_misc` |
| Terminal | Integrated terminal (cmd.exe on Windows, bash on Linux), typing, output | 🟡 | `scenario_tour`; Win7: no ConPTY, echo/line editing is local; Ctrl+C not verified |
| Notifications | Banner close button | ✅ | `scenario_ui --only banner`; toast buttons not tested |
| Drag and drop | Tab reorder, explorer item onto a folder (with the confirm dialog) | ✅ | `scenario_ui`; HTML5 DnD synthesized from the mouse (`dnd.js`), no drag image; dropping files from the OS is not supported |
| Scrollbars | Drag the thumb, click the track | ✅ | `scenario_ui` (needs pointer capture and `offsetY`) |
| Window | Resize / maximize (relayout), zoom (Ctrl +/-) | ✅ | `scenario_ui`; Wine/VM check pending (v11); zoom paints scaled, layout in CSS px |
| Text selection | Drag, double click (word), triple click (block), Ctrl+C in non-editable text | ✅ | `scenario_ui`; respects `user-select`; Ctrl+A in non-editable text not done |
| Extensions view | List built-in extensions, search box, details editor (Details/Features/Changelog tabs) | ✅ | `scenario_ui`; the Marketplace is not configured; README tab needs webviews |
| Webviews | Markdown preview, extension README (details page) | ✅ | `scenario_webview`: iframes are windows of their own (`frames.js`), the real webview shell (`pre/index.html`) runs; wheel scroll, text selection, Ctrl+C work. No service worker (resources are read directly), no ES-module scripts with `import` in frames |
| Images | `<img>` (PNG, JPEG baseline/progressive, GIF first frame, BMP, SVG), CSS `background-image: url()` (size/position/repeat), extension icons | ✅ | `tests/images_test.mjs` (exact for lossless formats), `images_render.mjs`; gradients (`linear-gradient`) are not drawn, no animated GIFs, SVG without filters/masks/text |
| Performance | Interaction latency (control benchmark: context menu, menus, open/switch file, caret, palette, New File/Folder) with 2 CPUs | 🟡 | `scenario_ctl --split 1` vs stock Electron VS Code ([spikes/12-control](spikes/12-control/README.md), [spikes/13-native-style](spikes/13-native-style/README.md)): v16 (selector matching and computed values in C) 75 to 460 ms on the sandbox machine of 2026-10-16, 3.0 to 9.2 times Electron 1.142 on the same machine (phase 1 only: 3.4 to 14.5 times; spike 12: 3 to 23 times); the laptop is about 2.4 to 3.4 times slower than the sandbox; laptop with v16: launch 20 s, open a file 2 s, caret/selection/New File/New Folder under 1 s, menus about 1 s (round 11); v18 cut the first style pass 4986 → 2380 ms on the laptop but launch and interactions were unchanged (round 12: the launch waits on other processes) |
| Launch | Time to a started workbench; launch timeline of all processes in the log | 🟡 | spike 14 / v19: the bytecode cache of large ES modules (from the second start): laptop launch 20 s → 12 s (round 13); v20 ships the cache so the first start is as fast (Wine: first = second start); `results\\desktop.txt` has the timeline |
| Quit | Closing the window ends every process of the app (main, shared process, extension host, file watcher, language servers, terminals); Explorer/browser launched by the app stay open | ✅ | v17: a Windows job object with kill-on-close (`winproc.c` `job_init`, per-child fallback inside a foreign job on Windows 7), utility processes exit and main quits when their parent's channel closes; Wine: 0 processes left after Alt+F4 or `kill -9` of the first process (v16: 4 left). Confirmed on the laptop (v17) |
| Syntax highlighting | TextMate grammars (JS/TS, JSON, CSS, HTML, Markdown, ...) with native Oniguruma 6.9.8 (no WebAssembly in the host) | ✅ | `scenario_more --only highlight`; module `spike:onig-native`, `10-main-shim/host/onig_shim98.js` replaces `vscode-oniguruma`; Wine builds link it statically. Tokenizes on the main thread (no workers) |
| Diff editor | Source Control change opens a side-by-side diff | ✅ | `scenario_more` |
| Themes | Switch color theme (Ctrl+K Ctrl+T) | ✅ | `scenario_more` |
| Diagnostics | Squiggles, Problems panel | ✅ | `scenario_more` |
| Editor | Go to definition (F12), Format Document, folding, multi-cursor, Welcome page | ✅ | `scenario_more` |
| Outline | Symbols of the open file | ✅ | `scenario_ui` |
| Split editor | Ctrl+\\ | ✅ | `scenario_ui`, `scenario_tour` |
| Timeline | View | ⬜ | |
| Debugging | Run and Debug | ⬜ | |
| Settings TOC | Count badge overlaps labels ("Diff E[0]ditor") | 🟡 | cosmetic |
| `<select>` | Native select popup | 🟡 | the workbench uses its own SelectBox; the native popup is not implemented |
| Shadow DOM | `attachShadow` | ❌ | throws; the editor option `useShadowDOM` is off |

## How to extend
Add a scenario (or a `--only` section in an existing one) per feature, keep the check names stable, and change the status here in the same commit. Known state hazards for scenarios: dirty tabs restored from `Backups`, orphaned `qjs-spike7` processes, stale `code.lock` (`runsc.sh` cleans these).
