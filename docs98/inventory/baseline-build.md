# Baseline — Building Stock VS Code on the Dev Machine

Taken at `32bbe1b8` (1.142.0) on the Linux dev machine (Fedora, 4 cores, 23 GB RAM, Node 24.18.0, gcc 16.2). This is a **Linux** build of unmodified upstream, used only to measure what the code needs. It is not a Windows build.

## Steps that worked

| Step | Command | Result |
|---|---|---|
| System libs (one-time, root) | `sudo dnf install -y krb5-devel libX11-devel libxkbfile-devel libsecret-devel` | Required by native modules (`kerberos`, `native-keymap`, `keytar`-style secret storage) |
| Install deps | `npm ci` | Exit 0; `node_modules` ≈ 1.6 GB; installs root, `remote/`, `build/`, extensions. 15 npm-audit warnings (not failures) |
| Transpile client | `npm run transpile-client` | **~25 s wall, 460 MB peak RSS**, 10,039 TS files → `out/` (269 MB incl. 2,299 copied resources) |
| Download Electron | `npm run electron` | ~56 s; lands in `.build/electron/code-oss` |

Not yet run: `npm run compile` (full type-check + gulp), launching the app, tests.

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
