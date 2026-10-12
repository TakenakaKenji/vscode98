#!/usr/bin/env bash
# Bundles the web workbench (target server-web, unminified, no NLS) with the repo's own esbuild-based bundler. ~20 s, ~5 GB RAM.
# Usage (repo root): bash docs98/spikes/08-workbench-boot/host/build_web.sh <outDir>   -> <outDir>/vs/code/browser/workbench/workbench.{js,css,html}
# The bundler resolves --out relative to the repo root, so an absolute path outside the repo is created below it first and moved.
set -euo pipefail
OUT=${1:?outDir}; ROOT=$(pwd); REL=out-web-spike8
node --experimental-strip-types --max-old-space-size=8192 build/next/index.ts bundle --out $REL --target server-web
rm -rf "$OUT" && mv "$ROOT/$REL" "$OUT" && echo "bundled to $OUT"
