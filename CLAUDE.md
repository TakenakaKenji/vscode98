# vscode98

This is a fork of microsoft/vscode (`upstream` remote) being turned into an Electron-free, standalone VS Code that can run on old Windows (7 → XP → 98).

**Before doing any work, read [docs98/INDEX.md](docs98/INDEX.md).** It is the table of contents for all project docs (goal, architecture, targets, roadmap, decisions, inventory). Keep it updated when adding or changing docs.

Also see [AGENTS.md](AGENTS.md) for upstream VS Code contribution/coding guidance.

Notes:
- The local clone has the git-lfs filter disabled in `.git/config` (git-lfs is not installed). Do not re-enable it unless git-lfs is installed.
- Project docs live in `docs98/`. Do not put project-specific notes into upstream files.
