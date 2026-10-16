# vscode98

This is a fork of microsoft/vscode (`upstream` remote) being turned into an Electron-free, standalone VS Code that can run on old Windows (7 → XP → 98).

**Before doing any work, read [docs98/CHECKPOINT.md](docs98/CHECKPOINT.md) (current status and next steps), then [docs98/INDEX.md](docs98/INDEX.md).** It is the table of contents for all project docs (goal, architecture, targets, roadmap, decisions, inventory). Keep it updated when adding or changing docs.

**Then read [docs98/retrospective/05-working-practices.md](docs98/retrospective/05-working-practices.md)**: the rules learned from earlier mistakes (control benchmark first, profile before porting, never retry around flakes, oracles for every optimisation, test the package on real Windows, commit early).

Also see [AGENTS.md](AGENTS.md) for upstream VS Code contribution/coding guidance.

Notes:
- The local clone has the git-lfs filter disabled in `.git/config` (git-lfs is not installed). Do not re-enable it unless git-lfs is installed.
- Project docs live in `docs98/`. Do not put project-specific notes into upstream files.
