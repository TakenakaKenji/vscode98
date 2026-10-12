#!/usr/bin/env bash
# Regenerates docs98/spikes/02-node-shim/host/impl/vspath.js: VS Code's own port of Node's `path` (src/vs/base/common/path.ts, both win32 and posix) bundled as one ES module.
# The `path` shim uses its `win32` flavour on Windows. Usage (repo root): bash docs98/spikes/11-windows-host/host/build_path.sh
set -euo pipefail
OUT=docs98/spikes/02-node-shim/host/impl/vspath.js
build/node_modules/.bin/esbuild src/vs/base/common/path.ts --bundle --format=esm --platform=neutral --target=es2020 --outfile="$OUT" --log-level=warning
echo "wrote $OUT ($(wc -c < $OUT) bytes)"
