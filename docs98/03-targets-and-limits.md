# 03 — Targets and Hard Limits

Staged OS targets. Each stage builds on the previous one. "Limit" means a property of the OS or hardware, not of effort.

> Several facts below come from general knowledge of Windows versions and have not been re-verified against sources in this project. Items marked **(unverified)** should be checked before being relied on.

## CPU baseline (decision D-009, 2026-10-12)

- **Baseline binary:** 32-bit x86, Pentium-class with an FPU, **no SSE/SSE2, no MMX, no CMOV** (x87 floating point, `-march=i586`). Built and statically checked by `docs98/spikes/07-native-render/host/build_baseline.sh`. An FPU is required (JS numbers are doubles).
- **Owner's stated oldest target (2026-10-12):** an AMD K7 (Athlon) with 128 MB RAM. The first goal is to get the application complete on newer targets, and to back-port to the oldest ones afterwards. (From general knowledge, not verified here: the original Athlon has MMX/3DNow! and CMOV but no SSE; Athlon XP adds SSE; SSE2 starts with the Pentium 4 and Athlon 64.)
- **Not yet measured:** any run on a real or emulated Pentium/K6/Athlon CPU. Measurements so far: a modern Xeon (sandbox), a Ryzen 5 5600G host running the Windows 7 VM, and the owner's Windows 7 laptop (about 2.4 to 3.4 times slower than the sandbox for this engine). Memory is the likely harder limit than the instruction set on a 128 MB machine: one captured workbench view alone used 218 MB RSS and the compiled workbench is ~86 MB of QuickJS heap (spikes 1 and 6); on the Windows 7 VM the full desktop app used ~573 MB working set with the renderer at 508 to 652 MB (spike 11), and ~715 MB in total on the sandbox (spike 12).

## Stage 1 — Windows 7

- NT kernel, Unicode (`W`) APIs, NTFS, overlapped I/O / IOCP, job objects, modern threading primitives.
- No ConPTY (introduced in Windows 10 1809). The terminal runs over plain pipes with a `node-pty` stand-in and a local line discipline (spike 11, round 6): works, but echo and line editing are local and Ctrl+C is not verified.
- Last Electron with Win 7/8/8.1 support was Electron 22 (Chromium 108). Irrelevant once Electron is dropped, but useful as a reference for what Chromium-level features Win 7 can host.
- TLS: older TLS defaults; modern TLS 1.2/1.3 may need updates or bundled crypto. **(unverified)**
- **Hard limits:** none identified after spikes 11 to 13 and ten rounds on a real Windows 7 VM and laptop. The practical limits found are speed (2.4 to 8.6 times slower than stock Electron VS Code per interaction, spike 13) and external tools that need newer Windows (ripgrep newer than 13.0.0 needs Windows 8 APIs; a git build for Windows 7 has to be installed by the user).

## Stage 2 — Windows XP

- NT kernel (5.1), Unicode APIs, NTFS, IOCP. Missing newer APIs (e.g. no Vista+ `GetTickCount64`, some threadpool/synchronization APIs, newer file APIs) so the toolchain and code must avoid them. **(unverified)** Measured in spike 11: the host's own Windows code imports only XP-era functions, but QuickJS-ng imports four Vista+ ones (`InitOnceExecuteOnce`, condition variables), which must be replaced (`check_imports.sh` lists them).
- Memory: 32-bit; practical user address space ~2 GB; many XP machines have 512 MB–2 GB RAM.
- Toolchain: modern MSVC no longer targets XP; use MinGW-w64 with an XP-compatible runtime, or old MSVC. The mingw-w64 cross-build of spike 11 links only against system DLLs that also exist on XP (kernel32, user32, gdi32, shell32, msvcrt, ws2_32, advapi32, winmm, psapi) and accepts `WINVER=0x0501`; not run on XP yet.
- Modern language servers, git, Rust/Go/Node tooling mostly do not run on XP.
- **Likely hard limits:** memory pressure for the workbench; external tools that cannot run on XP.

## Stage 3 — Windows 98 (and ME)

- Win9x kernel: **no NT features.**
  - No full Unicode API support (needs the Microsoft Layer for Unicode / `unicows`).
  - No NTFS, no overlapped file I/O on files, no IOCP, no job objects, weak process isolation, no real file permissions.
  - Cooperative 16-bit remnants, 64 KB-limited GDI heaps, limited handle counts. GDI resources are a real constraint for a complex UI.
  - Memory: practical RAM ceiling around 512 MB without tweaks; large address-space use is fragile. **(unverified)**
  - No `CreateProcess` features/pipes equivalent to NT in some cases; pty emulation needs a different approach.
- Toolchain: needs a compiler/runtime that targets Win9x (old MSVC, or MinGW with Win9x-compatible CRT / KernelEx-like shims). Modern Rust/Go do not target Win9x. **(unverified)**
- Networking: no modern TLS; online features would need bundled crypto. **(unverified)**
- External tools: essentially no modern git/LSP/debugger/Node toolchain runs on 98.
- **Likely hard limits:**
  - Anything depending on external modern binaries (most language servers, debuggers, modern git).
  - Webviews (need a real modern HTML engine; IE 5/6 is the only native option and very limited).
  - Remote development / online services (TLS, modern crypto).
  - Memory and GDI resource limits for the full workbench UI.

## Cross-cutting limits

| Limit | Affects |
|---|---|
| Single-threaded or weaker JS engine speed | Whole workbench responsiveness |
| Memory (32-bit, small RAM) | Large workspaces, extension host |
| No modern TLS | Marketplace, sync, auth, Copilot, remote |
| External binaries unavailable | Git, LSPs, debuggers, formatters |

## Per-feature feasibility table

Filled in as stages progress. Status: `unknown`, `possible`, `partial`, `impossible`. Windows 7 column updated 2026-10-16 from spikes 10 to 13, [FEATURES.md](FEATURES.md) and the owner's rounds; "possible (works)" means it works in the scenarios and was confirmed on the owner's Windows 7 VM or laptop.

| Feature | Win 7 | XP | 98 | Notes |
|---|---|---|---|---|
| Editor (Monaco) | possible (works) | unknown | unknown | Typing, caret, selection, find/replace, syntax highlighting (native Oniguruma), diff, folding, multi-cursor in scenarios; typing, click-to-caret and double click confirmed on the VM/laptop |
| Workbench UI | possible (works) | unknown | unknown | Menus and the command palette confirmed on the VM/laptop, drag-select on the VM; settings, themes, tabs, splits, drag and drop in scenarios; slower than Electron (spike 13). Shadow DOM, native `<select>` popup, gradients, grid/float/table layout not implemented ([FEATURES.md](FEATURES.md)) |
| File explorer / search / watching | possible (works) | unknown | unknown | Explorer new file/folder and Reveal in File Explorer confirmed on the laptop (v14), rename/delete in `scenario_explorer`; search via ripgrep 13.0.0 i686 (scenario; `rg.exe` on Windows 7 not separately confirmed); watching by polling (1 s) |
| Integrated terminal | partial | unknown | unknown | Pipes, no ConPTY; local echo; Ctrl+C not verified |
| Pure-JS extensions | possible (works) | unknown | unknown | 86 built-in extensions in the package; extension host on QuickJS-ng (spikes 3, 5, 10) |
| Extensions with native binaries | partial | unknown | unknown | VS Code's own native addons are JavaScript stand-ins (SQLite as JSON, polling watcher, keymap, pty over pipes); third-party native addons would need Windows 7 builds or stand-ins; none tested |
| Git | possible | unknown | unknown | The git extension and real `git` work in scenarios (Linux); on Windows 7 it needs a git for Windows build that still supports Windows 7, installed by the user (not tested on the laptop) |
| Language servers | possible | unknown | unknown | tsserver and the JSON/CSS/HTML/Markdown servers run on QuickJS-ng (completion, hover, diagnostics, go to definition in scenarios); not separately confirmed on the laptop |
| Webviews | partial | unknown | unknown | Markdown preview and extension READMEs as iframes with own documents; no service worker, no ES-module `import` in frames |
| Remote development | unknown | unknown | unknown | Not attempted |
| Marketplace / sync / auth | unknown | unknown | unknown | Not configured; AI/cloud features are out of scope for old Windows (D-008); TLS not examined |
