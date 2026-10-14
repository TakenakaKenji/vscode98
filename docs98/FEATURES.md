# Feature status (Windows host, QuickJS, own DOM/renderer)

What works, how it is tested, and what is known broken. "Scenario" = a headless script in `spikes/10-main-shim/host/scenario_*.mjs` that drives the booted workbench through the **same input driver as the native window** (`spikes/06-rendering/host/dom/input_driver.js`) and checks the DOM; run with `/tmp/claude-0/runsc.sh <scenario> [secs]` on the dev sandbox (see the spike 11 README for the Wine and VM flow). "VM" = confirmed by the owner on a real Windows 7 VM. Update this table whenever a feature is fixed or found broken.

Status: ✅ works in a scenario (and Wine where noted), 🟡 partly, ❌ broken, ⬜ not tested yet.

| Area | Feature | Status | Test / notes |
|---|---|---|---|
| Text boxes | Typing, caret, selection (mouse, keyboard), clipboard, undo/redo, placeholder in every `<input>`/`<textarea>` (quick open, find, settings search, SCM message, rename) | ✅ | `scenario_inputs`; VM confirmation pending (v11) |
| Explorer | New File, New Folder, rename, delete (to the recycle bin on Windows), context menu | ✅ | `scenario_explorer` (Linux; trash needs a VM check) |
| Search | Find in Files (ripgrep 13.0.0 i686), results tree, replace in files | ✅ | `scenario_search`; `rg.exe` on Win7 pending (v11) |
| Editor | Typing, undo/redo, cut/copy/paste, find, replace (Ctrl+H, replace all), save, dirty marker, wheel scroll | ✅ | `scenario_editor`, `scenario_misc` |
| Editor | Context menu (right click, Shift+F10 / Menu key) | ✅ | `scenario_misc --only context`; needs `editor.useShadowDOM: false` (seeded) |
| Editor | Completion, hover, diagnostics (JavaScript via the TS server on QuickJS) | ✅ | `scenario_lang` |
| Tabs | Switch, close button (a dirty tab prompts to save), several tabs | ✅ | `scenario_misc` |
| Command palette, Quick Open | Open, filter, run | ✅ | `scenario_tour`; VM: F1 0.5 to 1 s |
| Menus | Menu bar dropdowns, keyboard | ✅ | `scenario_tour`; VM (v10) |
| Settings editor | Search, text/number/dropdown/checkbox settings | ✅ | `scenario_settings` |
| Source control | Changes list, stage, commit message, commit (real `git`) | ✅ | `scenario_misc` |
| Terminal | Integrated terminal (cmd.exe on Windows, bash on Linux), typing, output | 🟡 | `scenario_tour`; Win7: no ConPTY, echo/line editing is local; Ctrl+C not verified |
| Notifications | Toasts, buttons | ⬜ | |
| Drag and drop | Tabs, explorer items, panels | ⬜ | |
| Scrollbars | Drag the thumb, click the track | ⬜ | |
| Window | Resize, maximize, minimize, zoom (Ctrl +/-) | ⬜ | |
| Text selection | In non-editable text (hover, markdown, output panels) | ⬜ | |
| Extensions view | List installed, details page, Marketplace | ⬜ | no network gallery configured; details page needs webviews |
| Webviews | Markdown preview, extension details, release notes | ❌ | needs `<iframe>` + `vscode-webview:` + service worker; not implemented |
| Outline / Timeline | Views | ⬜ | |
| Debugging | Run and Debug | ⬜ | |
| Settings TOC | Count badge overlaps labels ("Diff E[0]ditor") | 🟡 | cosmetic |
| `<select>` | Native select popup | 🟡 | the workbench uses its own SelectBox; the native popup is not implemented |
| Shadow DOM | `attachShadow` | ❌ | throws; the editor option `useShadowDOM` is off |

## How to extend
Add a scenario (or a `--only` section in an existing one) per feature, keep the check names stable, and change the status here in the same commit. Known state hazards for scenarios: dirty tabs restored from `Backups`, orphaned `qjs-spike7` processes, stale `code.lock` (`runsc.sh` cleans these).
