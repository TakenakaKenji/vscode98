#!/usr/bin/env bash
# Generates the Node-builtin shims for the QuickJS processes (main, utility processes, extension host) from the bundles of an app root (spike 2 generator + spike 5 implementations).
# Needs the spike 5 impl directory from 05-child-process/host/setup.sh (<spike5out>.impl). Usage (repo root, Node on PATH): bash docs98/spikes/10-main-shim/host/setup_qjs.sh <appRoot> <outDir> <spike5.impl>
# Then: qjs-spike7 --stack-size 0 docs98/spikes/05-child-process/host/fork_main.mjs <outDir> <abs path>/docs98/spikes/10-main-shim/host/boot_desktop_qjs.mjs <appRoot> --layout native --backend native ...
set -euo pipefail
APP=${1:?appRoot}; OUT=${2:?outDir}; IMPL=${3:?spike5 impl dir}
rm -rf "$OUT.impl" && cp -r "$IMPL" "$OUT.impl"
SHIM_IMPL_DIRS="$OUT.impl" node docs98/spikes/02-node-shim/host/gen_shims.mjs "$APP/out" "$OUT" main.js mainImpl.js bootstrap-fork.js vs/workbench/api/node/extensionHostProcess.js vs/code/electron-utility/sharedProcess/sharedProcessMain.js vs/platform/files/node/watcher/watcherMain.js vs/platform/terminal/node/ptyHostMain.js vs/platform/agentHost/node/agentHostMain.js > /dev/null
echo "shims in $OUT/shims, impl in $OUT.impl"
