#!/usr/bin/env bash
# Spike 3 sweep: boot the extension host on QuickJS-ng once per built-in extension (fresh process each) and record whether it loads and activates.
# Usage (repo root, Node 24 on PATH, production bundle in out-vscode-min/, dev out/ for the id table):
#   QJS=/path/to/qjs bash docs98/spikes/03-extension-loading/run_sweep.sh <hostDir> <results.jsonl> [settleMs]
set -uo pipefail
HOST=${1:?hostDir made by gen_shims.mjs}; RES=${2:?results.jsonl}; SETTLE=${3:-800}; QJS=${QJS:?path to qjs}; ROOT=$(pwd); D=docs98/spikes/03-extension-loading
node docs98/spikes/02-node-shim/host/gen_shims.mjs "$ROOT/out-vscode-min" "$HOST" vs/workbench/api/node/extensionHostProcess.js bootstrap-fork.js > /dev/null || exit 1
[ -f "$D/proxy-ids.json" ] || node "$D/dump_proxy_ids.mjs" > "$D/proxy-ids.json"
EXTS=$(node -e "
const fs=require('fs'),path=require('path');
for (const d of fs.readdirSync('extensions').sort()) { const pj=path.join('extensions',d,'package.json'); if(!fs.existsSync(pj)) continue;
  const p=JSON.parse(fs.readFileSync(pj,'utf8')); if(!p.main) continue; const m=path.join('extensions',d,p.main.endsWith('.js')?p.main:p.main+'.js'); if(fs.existsSync(m)) console.log(d); }")
ulimit -s 1048576; : > "$RES"
OVERLAY=${ESM_OVERLAY_DIR:-/tmp/esm-overlay}; mkdir -p "$OVERLAY"; export ESM_OVERLAY_DIR="$OVERLAY"
ESBUILD="$ROOT/build/node_modules/.bin/esbuild"
run_once() {  # <extension dirs...>
	rm -rf /tmp/spike
	NLS_MESSAGES="$ROOT/out-vscode-min/nls.messages.json" /usr/bin/time -f '%e %M' -o /tmp/sweep.time timeout 180 "$QJS" --stack-size 0 "$D/run_ext.mjs" "$HOST" "$ROOT/extensions" "$SETTLE" "$@" > /tmp/sweep.out 2> /tmp/sweep.err
}
# EXTRA_DEPS: extensions that must be loaded together (declared extensionDependencies)
declare -A EXTRA=( [git]="git-base" [github]="git-base" )
for e in $EXTS; do
	DIRS=(${EXTRA[$e]:-} $e)
	for round in 1 2 3 4 5 6 7 8; do   # require(esm) is not available: bundle each blocked ES module to CommonJS ahead of time, then retry
		run_once "${DIRS[@]}"
		F=$(grep -o 'require() of ES Module [^ ]* is not supported' /tmp/sweep.out | head -1 | sed 's/require() of ES Module //; s/ is not supported//')
		[ -z "$F" ] && break
		"$ESBUILD" "$F" --bundle --platform=node --format=cjs --conditions=node,module-sync --log-level=error --outfile="$OVERLAY/$(echo "$F" | sed 's|/|__|g').cjs" || break
	done
	echo "$e: $round round(s), overlay files so far: $(ls "$OVERLAY" | wc -l)" >&2
	python3 -I - "$e" "$RES" <<'PY'
import sys,json
ext,res=sys.argv[1:3]
row={'extension':ext, 'esmBundledOverlayFiles': len(__import__('os').listdir(__import__('os').environ.get('ESM_OVERLAY_DIR','/tmp/esm-overlay')))}
lines=[l for l in open('/tmp/sweep.out').read().splitlines() if l.startswith('{')]
t=open('/tmp/sweep.time').read().split()
row['wallSeconds']=float(t[-2]) if len(t)>=2 else None; row['peakKB']=int(t[-1]) if t else None
if lines:
    r=json.loads(lines[-1])
    if 'fatal' in r: row.update(status='runner-fatal', detail=r['fatal'])
    else:
        row.update(activated=r.get('activated'), activationErrors=r.get('activationErrors'), modulesLoaded=r.get('modulesLoadedByRequire'), eventResults=r.get('eventResults'),
                   stubbedCalls={k:v['calls'] for k,v in (r.get('stubbedCalls') or {}).items()}, rendererRequestKinds=len(r.get('rendererRequests') or {}),
                   unexpectedErrors=(r.get('rendererRequests') or {}).get('MainThreadErrors.$onUnexpectedError',{}).get('count',0))
        stubs=row['stubbedCalls']; ev=r.get('eventResults') or {}
        pj=json.load(open('extensions/%s/package.json'%ext)); own='%s.%s'%(pj.get('publisher','vscode'),pj['name'])   # judge the extension itself, not the dependencies loaded with it
        own_errors=[e for e in (r.get('activationErrors') or []) if e.get('ext')==own]
        row['id']=own
        if own in (r.get('activated') or []): row['status']='activated'
        elif own_errors: row['status']='activation-error'; row['activationErrors']=own_errors
        elif any(k.startswith('child_process') and 'fork' in k for k in stubs): row['status']='blocked: child_process.fork (language server)'
        elif any(v=='timeout' for v in ev.values()): row['status']='blocked: activation did not complete'
        else: row['status']='not triggered by the fired events'
        row['timings']=r.get('timings'); row['eventsFired']=r.get('eventsFired')
else:
    row.update(status='no-result', detail=open('/tmp/sweep.err').read()[:300])
open(res,'a').write(json.dumps(row)+'\n')
print(f"{ext:34s} {row['status'][:44]:44s} modules={row.get('modulesLoaded')} wall={row['wallSeconds']}s peakMB={(row['peakKB'] or 0)//1024} errs={len(row.get('activationErrors') or [])}")
PY
done
