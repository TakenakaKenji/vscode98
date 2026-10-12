#!/usr/bin/env bash
# Runs the TypeScript benchmark N times per engine and stores one JSON per run in <outdir>.
# Usage (repo root, Node 24 on PATH, QuickJS-ng built): QJS=/path/to/qjs bash docs98/spikes/02-node-shim/run_ts_bench.sh <outdir> [runs] [dir=src/vs/base/common]
set -uo pipefail
OUT=${1:?outdir}; RUNS=${2:-3}; DIR=${3:-src/vs/base/common}; ROOT=$(pwd); QJS=${QJS:?path to qjs}; H=docs98/spikes/02-node-shim
mkdir -p "$OUT"; ulimit -s 1048576
for n in $(seq 1 "$RUNS"); do
	for eng in node jitless qjs; do
		case $eng in
			node)   cmd=(node "$H/run_node.mjs") ;;
			jitless) cmd=(node --jitless "$H/run_node.mjs") ;;
			qjs)    cmd=("$QJS" --stack-size 0 "$H/run_qjs.mjs") ;;
		esac
		/usr/bin/time -f '%e %M' -o "$OUT/$eng-$n.time" "${cmd[@]}" "$ROOT" "$DIR" 15 2>/dev/null | grep '^{' > "$OUT/$eng-$n.json"
		echo "$eng run $n: $(tail -1 "$OUT/$eng-$n.time")  (elapsed s, peak RSS KB)"
	done
done
