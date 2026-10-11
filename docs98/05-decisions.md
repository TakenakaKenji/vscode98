# 05 — Decision Log

Format: ID, date, status (`accepted`, `proposed`, `rejected`, `superseded`), decision, rationale, alternatives.

## D-001 — Fork upstream `main`, shallow clone (2026-10-11) — accepted
- **Decision:** Work from `TakenakaKenji/vscode98` cloned with `--depth 1` from upstream `main` (1.142.0). Add `upstream` remote.
- **Why:** Full history is very large; deepen only when needed.
- **Alternatives:** Start from an old tag (Electron 22 era). Deferred; may be used for reference.

## D-002 — Disable git-lfs filter in this repo (2026-10-11) — accepted
- **Decision:** Local config `filter.lfs.*` set to `cat`, `required=false`.
- **Why:** `git-lfs` isn't installed; global config marks it required, which broke checkout. The only LFS file seen is an unrelated Copilot test cache.

## D-003 — Drop Electron by building a custom host, not by rewriting the UI natively (2026-10-11) — proposed
- **Decision:** Provide a minimal DOM/CSS/render layer + JS engine + Node shim so the existing workbench runs largely unchanged.
- **Why:** The workbench is ~1.1M lines written directly against the DOM; a native rewrite would lose most features. Goal is the full feature set.
- **Alternatives rejected:** (1) native toolkit rewrite — too large, loses extension compatibility; (2) WebView2/Tauri — requires newer Windows, defeats the goal; (3) plain Electron backport — can't reach XP/98.
- **Risk:** Performance of a small JS engine and a custom renderer; breadth of CSS needed. Phase 1 spikes test this.

## D-004 — JS engine — proposed (pending Phase 1)
- **Candidate:** QuickJS / QuickJS-ng. Others to compare: older V8 builds, Duktape, other embeddable engines.
- **Criteria:** buildable for Win 7/XP/98, ES level support, speed, memory, multi-context/worker support.

## D-005 — Render strategy — proposed (pending Phase 1)
- **Candidate:** Minimal DOM + CSS layout engine drawing via GDI.
- **Open:** how much CSS; Monaco rendering path; font/Unicode handling.

## D-006 — Process and IPC model — proposed (pending Phase 1)
- **Open:** processes vs threads for UI / extension host / shared process; replace Electron IPC with named pipes or sockets.

## D-008 — Scope out AI/agent/cloud features for old Windows (2026-10-11) — accepted
- **Decision:** Exclude `platform/agentHost`, Copilot/Anthropic/MCP SDKs, dev-tunnels, playwright, and similar from the old-Windows builds.
- **Why:** They need modern TLS, modern Node, and cloud services, and make up a large share of the npm imports (see [inventory/native-modules.md](inventory/native-modules.md)). They don't fit the "work on projects on old machines" goal. The owner confirmed.
- **Known consequence:** The Claude Code extension, which the owner uses heavily, will not run on the old targets (CPU/runtime limits). The owner will work around that later. Candidate ideas, none evaluated yet: use it from a modern machine against the same project, or a remote/terminal-based workflow.
- **Open:** exact list of modules/folders to exclude is to be produced during inventory pass 2.

## D-007 — Project docs location (2026-10-11) — accepted
- **Decision:** All project docs live in `docs98/` with `INDEX.md` as table of contents; root `CLAUDE.md` points to it.
- **Why:** Keep project-specific files out of upstream paths to ease merges; make context easy to reload.
