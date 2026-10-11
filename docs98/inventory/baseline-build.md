# Baseline — Building Stock VS Code on the Dev Machine

Taken at `32bbe1b8` (1.142.0) on the Linux dev machine (Fedora, 4 cores, 23 GB RAM, Node 24.18.0, gcc 16.2). This is a **Linux** build of unmodified upstream, used only to measure what the code needs. It is not a Windows build.

## Steps that worked

| Step | Command | Result |
|---|---|---|
| System libs (one-time, root) | `sudo dnf install -y krb5-devel libX11-devel libxkbfile-devel libsecret-devel` | Required by native modules (`kerberos`, `native-keymap`, `keytar`-style secret storage) |
| Install deps | `npm ci` | Exit 0; `node_modules` ≈ 1.6 GB; installs root, `remote/`, `build/`, extensions. 15 npm-audit warnings (not failures) |
| Transpile client | `npm run transpile-client` | **~25 s wall, 460 MB peak RSS**, 10,039 TS files → `out/` (269 MB incl. 2,299 copied resources) |
| Download Electron | `npm run electron` | ~56 s; lands in `.build/electron/code-oss` |
| Compile built-in extensions | `npm run gulp compile-extensions` | **~32 s wall, 290 MB peak RSS**; fixes the extension activation errors seen in the first launch |
| Build extension media (webview scripts/styles) | `npm run gulp compile-extension-media` | ~10 s. **Required for webviews**: without it the markdown preview (and other extension webviews) render blank because their `media/*.js` return 404 |
| codicon font | `cp node_modules/@vscode/codicons/dist/codicon.ttf src/vs/base/browser/ui/codicons/codicon/ ` and `out/…/codicon/` | Normally done by the full gulp compile; the transpile-only path skips it. Both copies are gitignored |

Not yet run: `npm run compile` (full type-check + gulp), a windowed launch, tests.

## Headless launch (works on Fedora 44, Wayland session)

Electron 43.7.7 runs here: `ldd` shows no missing libraries and user namespaces are enabled for the sandbox. A dev-mode launch with `--ozone-platform=headless --disable-gpu --no-sandbox` and a temp `--user-data-dir`/`--extensions-dir` loaded the full workbench and started four helper processes (shared process, extension host, agent host, renderer). It ran until the 40 s timeout killed it (the crash lines at the end are that SIGTERM, exit code 15).

Command used (from repo root, `VSCODE_DEV=1 NODE_ENV=development`):

```
.build/electron/code-oss . --ozone-platform=headless --disable-gpu --no-sandbox \
  --user-data-dir=<tmp> --extensions-dir=<tmp> --disable-extension=vscode.vscode-api-tests
```

Caveats:
- First renderer log line came ~16 s after the main process started, in **unbundled dev mode** (10k module files, no GPU, no compile cache). It is **not** a valid startup-time baseline. Memory was not measured.
- On that first launch built-in extensions failed to activate (`extensions/*/out` not compiled) and `codicon.ttf` was missing from `out/`. Both were build gaps, not platform problems, and are fixed by the extension compile + font copy above.
- The launch created `~/.vscode-oss-shared/` in the home directory (shared storage), outside the temp profile.
- A real windowed launch on Wayland (vs headless) has not been tried.

## What the transpiled output looks like (`out/`)

Static scan of `out/vs/**/*.js` (10,065 files, 222 MB of JS; **not bundled or minified**; the shipped product bundles):

| Observation | Value |
|---|---|
| Module format | ES modules (`import …` statements in 8,546 files); `require(` in 34 files |
| Optional chaining `?.` | 4,474 files (kept verbatim, not lowered) |
| Nullish `??` | 3,067 files |
| `async`/`await` | 4,447 files |
| Class `static {}` blocks | 1,344 files |
| Private `#fields` | 28 files |
| Regex lookbehind | 18 files |
| Dynamic `import()` | 105 files |
| Remaining `@decorator(` | 2 files (TS parameter decorators are compiled away) |
| `using` declarations | 0 |
| `FinalizationRegistry` | present in core (`base/common/lifecycle.js`) |
| Entry points | `out/vs/workbench/workbench.desktop.main.js`, `workbench.web.main.js`, `workbench.common.main.js` |

Conclusion: the code that actually reaches the JS engine is **modern ES2024 syntax with ES modules**. The old-Windows JS engine must support (or the build must lower) all of the above. See [js-language-level.md](js-language-level.md).

## Issues found while building

- `git-lfs` missing broke the first clone checkout (fixed locally, see D-002).
- System dev libraries were missing (see above).
- npm prints warnings that `.npmrc` keys (`target`, `runtime`, `ms_build_id`, …) are unknown project config; these are used by `node-gyp`, so harmless.

## Next baseline items

- [ ] `npm run compile` (type-check) time and memory.
- [ ] Launch stock VS Code with an isolated `--user-data-dir`, measure cold-start time and idle memory (per process).
- [ ] Runtime API trace (CDP or instrumented preload) of startup + open folder + edit + terminal + search.
- [ ] Produce the production **bundle** (`gulp vscode-linux-x64`-style task) and measure bundle size, since a custom host would load the bundle, not 10k files.
