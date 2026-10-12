#!/usr/bin/env bash
# Spike 2b, one command: generate shims + rewritten bundles and evaluate every Node-side bundle on QuickJS-ng.
# Usage (repo root, Node 24 on PATH, production bundle built into out-vscode-min/): QJS=/path/to/qjs bash docs98/spikes/02-node-shim/host/run_bundles.sh <outDir> [resultsFile.jsonl]
set -uo pipefail
OUT=${1:?outDir}; RES=${2:-$OUT/results.jsonl}; QJS=${QJS:?path to qjs}; H=$(cd "$(dirname "$0")" && pwd); B=$(pwd)/out-vscode-min
ENTRIES=(vs/workbench/api/node/extensionHostProcess.js vs/code/electron-utility/sharedProcess/sharedProcessMain.js vs/platform/terminal/node/ptyHostMain.js vs/platform/files/node/watcher/watcherMain.js bootstrap-fork.js)
node "$H/gen_shims.mjs" "$B" "$OUT" "${ENTRIES[@]}" > "$OUT.gen.json" || exit 1
ulimit -s 1048576; : > "$RES"
run() { # <label> <entry> <extra env...>
	local label=$1 entry=$2; shift 2
	( cd "$OUT" && env NLS_MESSAGES="$B/nls.messages.json" "$@" /usr/bin/time -f '%e %M' -o "$OUT/time.tmp" "$QJS" --stack-size 0 "$H/run_entry.mjs" "$OUT" "$entry" 3000 2>/dev/null | grep '^{"entry' | python3 -c "
import sys,json
d=json.loads(sys.stdin.read()); d['label']='$label'; d['wallSecondsAndPeakKB']=open('$OUT/time.tmp').read().split()
d.pop('portMessagesFromBundle',None) if '$label'!='extension host + init data' else None
print(json.dumps(d))" >> "$RES" )
}
run "extension host (waits for parentPort message)" vs/workbench/api/node/extensionHostProcess.js
run "extension host + init data" vs/workbench/api/node/extensionHostProcess.js INITDATA=1
run "shared process" vs/code/electron-utility/sharedProcess/sharedProcessMain.js
run "pty host" vs/platform/terminal/node/ptyHostMain.js
run "file watcher" vs/platform/files/node/watcher/watcherMain.js
run "bootstrap-fork.js -> extension host" bootstrap-fork.js VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess
python3 - "$RES" <<'PY'
import sys,json
for l in open(sys.argv[1]):
    d=json.loads(l)
    print(f"{d['label']:48s} evaluated={d['evaluated']!s:5} evalMs={d['evalMs']:4d} waitingForParent={d.get('waitingForParentPortMessage')!s:5} stubsCalled={d.get('stubbedCallCount')} msgsFromBundle={d.get('portMessageCount','-')} wall/peakKB={d['wallSecondsAndPeakKB']}")
PY
