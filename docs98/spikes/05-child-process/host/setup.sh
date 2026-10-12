#!/usr/bin/env bash
# Prepares everything the spike-5 tests need under <out>: the qjs-spike5 binary, the generated shims (spike-2 generator + this spike's impl overrides),
# and the bundled streams. Layout: <out> = generated shims + rewritten bundles (gen_shims wipes it), <out>.impl = this spike's impl files, <out>.bin = host binary. Usage (repo root, Node 24 on PATH): bash docs98/spikes/05-child-process/host/setup.sh <out> [entryBundle...]
set -euo pipefail
OUT=${1:?out}; shift || true
H=$(cd "$(dirname "$0")" && pwd); B=$(pwd)/out-vscode-min; ENTRIES=("$@"); [ ${#ENTRIES[@]} -gt 0 ] || ENTRIES=(bootstrap-fork.js)
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
bash "$H/build.sh" "$OUT.bin" >/dev/null
node "$H/build_impl.mjs" "$OUT.impl" "$OUT/shims" >/dev/null
SHIM_IMPL_DIRS="$OUT.impl" node "$H/../../02-node-shim/host/gen_shims.mjs" "$B" "$OUT" "${ENTRIES[@]}" >/dev/null
echo "ready: $OUT.bin/qjs-spike5, shims in $OUT/shims, impl in $OUT.impl"
