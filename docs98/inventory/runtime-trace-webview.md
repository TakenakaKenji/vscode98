# Inventory — Webviews (Markdown Preview Deep-Dive)

Webviews are how extensions show their own HTML UI (markdown preview, custom editors, notebook renderers, simple browser, settings pages of extensions). They are the part of VS Code that most needs a **real HTML engine**, so this one was measured separately.

- **Taken at:** `32bbe1b8` (1.142.0), Electron 43.7.7 / Chromium 150, Linux, headless, dev mode.
- **Scenario:** open `README.md` (a ~60-line doc with headings, lists, tables, inline code) and run *Markdown: Show Preview*.
- **Driver:** [scripts/trace_webview.mjs](scripts/trace_webview.mjs) (run with `bash docs98/inventory/scripts/run_scenarios.sh <workdir> 9333 trace_webview.mjs`).
- **Data:** [data/webview-markdown-preview.json](data/webview-markdown-preview.json), screenshot [data/shots/markdown-preview-rendered.png](data/shots/markdown-preview-rendered.png).

## Correction to the earlier scenario trace

[runtime-trace-scenarios.md](runtime-trace-scenarios.md) reported a **blank** preview and speculated it might be a headless limitation. That was wrong. The cause was an **incomplete build**: `npm run gulp compile-extensions` does not build extension *media* (webview scripts/styles). The preview asked for `media/index.js`, `media/pre.js`, the KaTeX CSS and the Mermaid bundle, all returned HTTP 404, and the inner page stayed empty. After `npm run gulp compile-extension-media` (a few seconds) the preview renders fully in headless mode. Lesson: webview content depends on a separate build step; add it to the baseline build ([baseline-build.md](baseline-build.md)).

## How a webview is built (verified)

```
workbench page  (vscode-file://…)
 └─ <iframe src="vscode-webview://<id>/index.html?id=…&parentId=…&origin=…"      ← "shell"
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
        allow="cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write"
     │   (separate origin per webview; runs a module script; registers a service worker)
     └─ <iframe src="./fake.html?id=…">                                          ← "content"
            sandbox="allow-same-origin allow-pointer-lock allow-scripts allow-downloads"
            (same origin as the shell, so the shell can read its document directly)
```

- **Two nested iframes.** The shell is a small page (a few `<meta>`, one script, one iframe). The content frame holds the extension's HTML.
- **A service worker** on the `vscode-webview://` origin controls the frame (`navigator.serviceWorker.controller` was set). It rewrites/intercepts resource loads.
- **Local files are fetched by the workbench, not the webview.** Resource URLs are rewritten to `https://file+.vscode-resource.vscode-cdn.net/<absolute path>`. The service worker forwards each request to the workbench page (`Webview.loadLocalResource`), which reads the file through VS Code's file service and replies. A missing file produces an HTTP 404 (seen when the media was not built).
- **Messaging** between workbench ↔ shell ↔ content uses `postMessage` and a `MessageChannel`.
- **Isolation:** each webview gets its own origin (`vscode-webview://<unique id>`), with `allow-same-origin` + `allow-scripts` inside the sandbox. Chromium warns that this combination "can escape its sandboxing", so isolation relies on the unique origin, not the sandbox flags.
- **CSP:** the content frame forbids `eval` (`script-src 'nonce-…'`), so tooling cannot `eval` strings inside it.
- **Observed in the console:** `Unrecognized feature: 'local-network-access'` (a newer permission-policy token Chromium 150 does not know; harmless). A `TypeError: Cannot read properties of undefined (reading 'selection')` at `CustomEditorInput.applyOptions` appears in the workbench page in both runs when opening the preview; it looks like an upstream bug on this code path and was **not investigated**.

## What the markdown content frame actually used

Rendered document: **145 elements**, max depth 8, 7 stylesheets, 975 CSS rules, 4 `<script>`, 5 `<link>`, 1 `<base>`.

| Item | Value |
|---|---|
| Element types | `h1` 1, `h2` 7, `p` 3, `strong` 3, `a` 3, `code` 44, `ul` 2, `li` 9, `ol` 1, `table` 2, `thead/tbody` 2+2, `tr` 15, `th` 4, `td` 26, `div` 2, `span` 1 |
| `display` values (live) | inline 51, block 18, none 16, `table-cell` 30, `table-row` 15, `list-item` 9, `table` 2, `table-header-group` 2, `table-row-group` 2. **No flex, no grid** in this document |
| `position` | static 145 (all) |
| Distinct standard CSS properties in rules | 144 |
| Rule types | `CSSStyleRule` 951, `@font-face` 21 (KaTeX fonts), `@layer` block 1 (VS Code's default styles live in `@layer vscode-default`), `@keyframes` 1 |
| Selector features | `::before/::after` 586 rules (KaTeX), `>` 31, `:hover` 18, `::-webkit-scrollbar` 5, `:not()` 5, attribute selectors 3 |
| Fonts | 13 families: 12 `KaTeX_*` + `codicon` |
| Effects | `border-radius` on 44 elements; no transforms, shadows on live elements, or filters |

Interpretation: the **default styles and markdown stylesheet are modest** (typography, tables, lists, code blocks, a few pseudo-elements). The large pieces are KaTeX's stylesheet and fonts, which only matter if math is used. This is a **lower bound**: webviews run arbitrary extension-authored HTML/CSS/JS.

## Requirements this adds for the host

1. A **real HTML/CSS engine** for the content frame: document flow, inline text, **table layout** (markdown tables), lists, `<code>`/`<pre>`, `@layer`, custom properties, `@font-face` with web fonts, links, scrolling, selection. Flex/grid are likely needed for other extensions' UIs.
2. **Nested browsing contexts with per-origin isolation** and `postMessage`/`MessageChannel`.
3. A **custom URL scheme** (`vscode-webview:`) with unique origins, plus **service-worker-style interception** of resource loads (or an equivalent hook: the host could serve `vscode-resource` URLs natively instead of using a service worker).
4. **JavaScript in the content frame** (the markdown preview runs `pre.js`/`index.js`), which means a second JS realm per webview with DOM access.
5. A **sandbox/CSP model** (`script-src` nonces, no `eval`).

## Not measured / still open

- **Other webviews:** notebook renderers, custom editors, the simple browser (embeds arbitrary web pages), extension welcome pages, and Copilot/agent UIs were not traced. Extensions' own webviews can be arbitrarily complex.
- **JS/DOM API usage inside the content frame:** the API counters were only installed in the workbench page. Counting APIs inside webview frames needs the same instrumentation injected into those frames (they are separate targets).
- **Performance** of rendering and scrolling a large document.
- Whether a **minimal** engine (as proposed for the workbench) can serve webviews, or webviews need a fuller one, or are treated as an optional feature on the oldest targets (see [../03-targets-and-limits.md](../03-targets-and-limits.md): webviews are already listed as a likely hard limit on Win 98).
