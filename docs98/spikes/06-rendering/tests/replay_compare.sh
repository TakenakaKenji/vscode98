#!/usr/bin/env bash
# Static replay of a captured workbench (Node): layout + paint, then element/pixel comparison against the Chromium capture. Usage: replay_compare.sh <captured.json> <outPrefix>
set -uo pipefail
C=${1:?captured.json}; O=${2:?outPrefix}; T=docs98/spikes/06-rendering/tests; H=docs98/spikes/06-rendering/host
node $H/run_replay_node.mjs "$C" --dump $O.ours.json --ppm $O.ours.ppm 2>&1 | cut -c1-300
python3 - "$C" "$O" <<'PY'
import json,sys
t=json.load(open(sys.argv[1])); o=json.load(open(sys.argv[2]+'.ours.json'))
keep=lambda e: e['path'].startswith('html/body')
json.dump({'elements':[e for e in t['elements'] if keep(e)]}, open(sys.argv[2]+'.truth_body.json','w')); json.dump({'elements':[e for e in o['elements'] if keep(e)]}, open(sys.argv[2]+'.ours_body.json','w'))
PY
python3 $T/compare.py $O.truth_body.json $O.ours_body.json --verbose ${VERBOSE:-20} 2>&1 | cut -c1-240
python3 -W ignore $T/pixel_diff.py ${C%.json}.png $O.ours.ppm $O
