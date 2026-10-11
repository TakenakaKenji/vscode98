# 00 — Overview

## What this is

**vscode98** is a fork of [microsoft/vscode](https://github.com/microsoft/vscode) (fork: `TakenakaKenji/vscode98`). The aim is to run VS Code as a standalone native application, without Electron, on progressively older versions of Windows, with Windows 98 as the extreme end.

## Why

The owner wants to work on projects on old Windows machines, including Windows 98 devices. Upstream VS Code cannot run there: it requires Electron (Chromium + Node.js), and both dropped old Windows versions long ago.

## Starting point

- Forked from upstream `main`, version 1.142.0 at clone time (commit `32bbe1b8`, 2026-10-11).
- Shallow clone (`--depth 1`). Deepen with `git fetch upstream --tags` when history or old tags are needed.
- Electron 43.7.7 (`.npmrc`), Node 24.x for the remote server (`remote/.npmrc`), Node 22.x for build tooling (`build/.npmrc`).
- Installer minimum is Windows 10 (`build/win32/code.iss`, `MinVersion=10.0`).

## Remotes

| Remote | URL |
|---|---|
| `origin` | https://github.com/TakenakaKenji/vscode98 |
| `upstream` | https://github.com/microsoft/vscode |

## Local environment notes

- Working copy: `~/Documents/GitHub/vscode98` (Fedora Linux host). Windows builds/testing need a Windows machine or VM. **(not yet set up)**
- `git-lfs` is not installed; the LFS filter is disabled in this repo's local config. The only LFS file seen is a Copilot test cache (`extensions/copilot/test/simulation/cache/base.sqlite`), irrelevant to this project.

## Repository layout (upstream, relevant parts)

| Path | Role |
|---|---|
| `src/vs/base` | Foundation utilities, split into `common` / `browser` / `node` |
| `src/vs/platform` | Services (files, terminal, storage, ...), same split plus `electron-main` |
| `src/vs/editor` | Monaco editor core |
| `src/vs/workbench` | The VS Code application UI and features (largest part) |
| `src/vs/code` | App entry points: `electron-main`, `electron-browser`, `electron-utility`, `node` |
| `src/vs/server` | Standalone Node server (remote development) |
| `extensions/` | Built-in extensions (languages, git, themes, ...) |
| `build/` | Build, packaging, installer |
| `remote/` | Remote server dependencies |
| `cli/` | Rust CLI |
| `docs98/` | **This project's docs** |

Folder-naming convention in upstream: `common` = no DOM and no Node; `browser` = needs DOM; `node` = needs Node; `electron-main` / `electron-browser` / `electron-sandbox` / `electron-utility` = Electron-specific.

## How to work in this repo

1. Read `docs98/INDEX.md`.
2. Record decisions in `05-decisions.md` and update status in `04-roadmap.md`.
3. Keep project-specific code in clearly separate new directories where possible, to make merging upstream easier.
