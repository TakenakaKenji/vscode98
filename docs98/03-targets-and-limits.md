# 03 — Targets and Hard Limits

Staged OS targets. Each stage builds on the previous one. "Limit" means a property of the OS or hardware, not of effort.

> Several facts below come from general knowledge of Windows versions and have not been re-verified against sources in this project. Items marked **(unverified)** should be checked before being relied on.

## CPU baseline (decision D-009, 2026-10-12)

- **Baseline binary:** 32-bit x86, Pentium-class with an FPU, **no SSE/SSE2, no MMX, no CMOV** (x87 floating point, `-march=i586`). Built and statically checked by `docs98/spikes/07-native-render/host/build_baseline.sh`. An FPU is required (JS numbers are doubles).
- **Owner's stated oldest target (2026-10-12):** an AMD K7 (Athlon) with 128 MB RAM. The first goal is to get the application complete on newer targets, and to back-port to the oldest ones afterwards. (From general knowledge, not verified here: the original Athlon has MMX/3DNow! and CMOV but no SSE; Athlon XP adds SSE; SSE2 starts with the Pentium 4 and Athlon 64.)
- **Not yet measured:** any run on a real or emulated Pentium/K6/Athlon CPU. All measurements so far are on a modern Xeon. Memory is the likely harder limit than the instruction set on a 128 MB machine: one captured workbench view alone used 218 MB RSS and the compiled workbench is ~86 MB of QuickJS heap (spikes 1 and 6).

## Stage 1 — Windows 7

- NT kernel, Unicode (`W`) APIs, NTFS, overlapped I/O / IOCP, job objects, modern threading primitives.
- No ConPTY (introduced in Windows 10 1809). Terminal needs winpty or plain pipes. **(unverified)**
- Last Electron with Win 7/8/8.1 support was Electron 22 (Chromium 108). Irrelevant once Electron is dropped, but useful as a reference for what Chromium-level features Win 7 can host.
- TLS: older TLS defaults; modern TLS 1.2/1.3 may need updates or bundled crypto. **(unverified)**
- **Hard limits:** none identified. Everything should be achievable.

## Stage 2 — Windows XP

- NT kernel (5.1), Unicode APIs, NTFS, IOCP. Missing newer APIs (e.g. no Vista+ `GetTickCount64`, some threadpool/synchronization APIs, newer file APIs) so the toolchain and code must avoid them. **(unverified)**
- Memory: 32-bit; practical user address space ~2 GB; many XP machines have 512 MB–2 GB RAM.
- Toolchain: modern MSVC no longer targets XP; use MinGW-w64 with an XP-compatible runtime, or old MSVC. **(unverified)**
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

Filled in as stages progress. Status: `unknown`, `possible`, `partial`, `impossible`.

| Feature | Win 7 | XP | 98 | Notes |
|---|---|---|---|---|
| Editor (Monaco) | unknown | unknown | unknown | |
| Workbench UI | unknown | unknown | unknown | |
| File explorer / search / watching | unknown | unknown | unknown | |
| Integrated terminal | unknown | unknown | unknown | |
| Pure-JS extensions | unknown | unknown | unknown | |
| Extensions with native binaries | unknown | unknown | unknown | |
| Git | unknown | unknown | unknown | |
| Language servers | unknown | unknown | unknown | |
| Webviews | unknown | unknown | unknown | |
| Remote development | unknown | unknown | unknown | |
| Marketplace / sync / auth | unknown | unknown | unknown | |
