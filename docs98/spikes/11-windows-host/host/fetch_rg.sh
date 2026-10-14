#!/usr/bin/env bash
# Fetches ripgrep 13.0.0 for 32-bit Windows (the last release line that runs on Windows 7: its imports are kernel32/advapi32/ws2_32/userenv, Vista-level SRW locks at most;
# newer builds import WaitOnAddress/ProcessPrng, which Windows 7 lacks) and prints the path of rg.exe. The search view of the workbench spawns it.
# Usage: bash fetch_rg.sh [cache dir]   (default /tmp/claude-0/rgdl)
set -euo pipefail
D=${1:-/tmp/claude-0/rgdl}; mkdir -p "$D"; Z="$D/ripgrep-13.0.0-i686-pc-windows-msvc.zip"; SUM=725fab270e0c7419e0032b8dcf28cb399337be9d4867d4e527a1d9671efecffb
if [ ! -f "$Z" ] || [ "$(sha256sum "$Z" | cut -d' ' -f1)" != "$SUM" ]; then curl -sSL -m 180 -o "$Z" https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep-13.0.0-i686-pc-windows-msvc.zip; fi
[ "$(sha256sum "$Z" | cut -d' ' -f1)" = "$SUM" ] || { echo "ripgrep zip: checksum mismatch" >&2; exit 1; }
rm -rf "$D/x" && mkdir -p "$D/x" && unzip -q -o "$Z" -d "$D/x" && echo "$D/x/ripgrep-13.0.0-i686-pc-windows-msvc"
