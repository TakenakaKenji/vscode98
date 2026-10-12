#!/usr/bin/env bash
# Bundles the DESKTOP workbench and the electron-main/utility bundles (target desktop, unminified, no NLS) with the repo's own esbuild bundler and lays out an "app root":
#   <appRoot>/out/...  <appRoot>/product.json  <appRoot>/package.json  <appRoot>/node_modules -> repo node_modules  <appRoot>/extensions -> repo extensions (compiled)
# Usage (repo root): bash docs98/spikes/10-main-shim/host/build_desktop.sh <appRoot>      (~50 s, ~5 GB RAM)
set -euo pipefail
APP=${1:?appRoot}; ROOT=$(pwd); REL=out-desktop-spike10
node --experimental-strip-types --max-old-space-size=8192 build/next/index.ts bundle --out $REL --target desktop
rm -rf "$APP" && mkdir -p "$APP" && mv "$ROOT/$REL" "$APP/out"
cp product.json package.json "$APP/"; ln -sfn "$ROOT/node_modules" "$APP/node_modules"; ln -sfn "$ROOT/extensions" "$APP/extensions"
echo "app root: $APP"
