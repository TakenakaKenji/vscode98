#!/usr/bin/env python3
"""Aggregate the per-process JSON files written by node_hook.cjs into a summary (app-called APIs only).
Usage: python3 -I docs98/inventory/scripts/analyze_proc_trace.py <dir containing proc/*.json> [out.json]"""
import json, glob, collections, re, sys
S = sys.argv[1]; OUT = sys.argv[2] if len(sys.argv) > 2 else None
procs = [json.load(open(f)) for f in sorted(glob.glob(S + '/proc/*.json'))]
def pname(d):
    # utility processes carry VSCODE_ESM_ENTRYPOINT; the Electron main process has type 'browser'; Node children (tsserver, language servers) are named by their script
    if d['entry']: return d['entry'].split('/')[-1]
    if d['type'] == 'browser': return 'main'
    return '/'.join((d['argv1'] or '?').split('/')[-2:]) + ' (child)'
BUILT = ('original-fs.promises','fs.promises','dns.promises','original-fs','fs','child_process','net','dgram','dns','http','https','http2','tls','os','crypto','zlib','worker_threads','cluster','readline','vm','v8','inspector','perf_hooks','util','url','querystring','string_decoder','module','async_hooks','tty','stream','buffer')
def modof(k):
    for m in sorted(BUILT, key=len, reverse=True):
        if k.startswith(m + '.'): return m
res = {'processes': [{'name': pname(d), 'type': d['type'], 'pid': d['pid'], 'uptimeSec': d['uptimeMs'] // 1000, 'nativeAddons': d['nativeAddons'], 'keys': len(d['counts']), 'appCalledKeys': len(d['appCalled'])} for d in procs]}
node = collections.defaultdict(lambda: collections.defaultdict(lambda: {'calls': 0, 'procs': set()}))
internal = collections.Counter(); proc_api = collections.defaultdict(set); env_get = collections.defaultdict(set); env_set = collections.defaultdict(set)
electron = collections.defaultdict(lambda: {'calls': 0}); ipc_reg = {}; ipc_recv = collections.Counter(); electron_events = collections.defaultdict(int)
for d in procs:
    app = set(d['appCalled']); n = pname(d)
    for k, v in d['counts'].items():
        if k.startswith('env.'):
            (env_get if k.startswith('env.get:') else env_set if k.startswith('env.set:') else collections.defaultdict(set))[k.split(':', 1)[-1]].add(n); continue
        if k.startswith('process.'): proc_api[k[8:]].add(n); continue
        if k.startswith('native:'): continue
        if k.startswith('electron.'):
            m = re.match(r'electron\.ipcMain\.(on|once|addListener|handle|handleOnce)\((.*)\)$', k)
            if m: ipc_reg[m.group(2)] = m.group(1); continue
            m = re.match(r'electron\.ipcMain\.recv\((.*)\)$', k)
            if m: ipc_recv[m.group(1)] += v; continue
            if k in app: electron[k]['calls'] += v
            continue
        m = modof(k)
        if not m: continue
        if k in app: node[m][k[len(m) + 1:]]['calls'] += v; node[m][k[len(m) + 1:]]['procs'].add(n)
        else: internal[m] += v
res['nodeBuiltins'] = {m: {f: {'calls': x['calls'], 'processes': sorted(x['procs'])} for f, x in sorted(fn.items(), key=lambda kv: -kv[1]['calls'])} for m, fn in sorted(node.items(), key=lambda kv: -sum(x['calls'] for x in kv[1].values()))}
res['nodeInternalOnlyCalls'] = dict(internal)
res['processMembers'] = {k: sorted(v) for k, v in sorted(proc_api.items())}
# Environment variable NAMES are machine-specific (shell, desktop, other tools). Keep only VS Code/Electron/standard names in the
# committed summary and report the rest as counts per prefix.
STD = set('HOME PATH USERPROFILE APPDATA LOCALAPPDATA TEMP TMP TMPDIR SHELL LANG LC_ALL DISPLAY PWD USER USERNAME COMSPEC SYSTEMROOT PROGRAMFILES PROGRAMDATA HOMEDRIVE HOMEPATH WINDIR NODE_ENV NODE_OPTIONS PATHEXT OS PROCESSOR_ARCHITECTURE TERM TERM_PROGRAM COLORTERM HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY EDITOR VISUAL CI DEBUG XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_SESSION_TYPE'.split())
keep = lambda n: n in STD or n.startswith(('VSCODE_', 'ELECTRON_'))
res['envVarNamesRead'] = {k: sorted(v) for k, v in sorted(env_get.items()) if keep(k)}
res['envVarNamesReadTotal'] = len(env_get)
res['envVarNamesReadOtherByPrefix'] = dict(collections.Counter(k.split('_')[0] for k in env_get if not keep(k)).most_common())
res['envVarNamesSet'] = {k: sorted(v) for k, v in sorted(env_set.items()) if keep(k)}
res['envVarNamesSetTotal'] = len(env_set)
res['electronApis'] = {k: v['calls'] for k, v in sorted(electron.items(), key=lambda kv: -kv[1]['calls'])}
res['ipcChannelsRegistered'] = dict(sorted(ipc_reg.items())); res['ipcChannelsReceived'] = dict(ipc_recv.most_common())
# per-process view: distinct app-called functions per Node module
per = {}
for d in procs:
    app = set(d['appCalled']); m2 = collections.Counter()
    for k in app:
        m = modof(k)
        if m and not k.startswith(('electron.', 'process.', 'env.')): m2[m] += 1
    per[pname(d)] = {'distinctAppCalledNodeFunctions': dict(m2.most_common()), 'electronApiKeysCalled': sum(1 for k in app if k.startswith('electron.')),
                     'childProcesses': sorted({k[len('child_process.'):] for k in app if k.startswith('child_process.') and '(' in k and not k.startswith('child_process.ChildProcess')})}
res['perProcess'] = per
launch = collections.defaultdict(lambda: collections.Counter())
for d in procs:
    for k, v in (d.get('childLaunches') or {}).items(): launch[pname(d)][k] += v
res['nodeChildLaunchesByParent'] = {p: dict(c) for p, c in sorted(launch.items())}
if OUT: json.dump(res, open(OUT, 'w'), indent=1)
# ---- human summary
print('processes:', [(p['name'], p['type']) for p in res['processes']])
print('\n== Node built-ins called by app code (distinct fns / calls); internal-only calls in brackets ==')
for m, fn in res['nodeBuiltins'].items(): print(f"{m:20s} fns={len(fn):3d} calls={sum(x['calls'] for x in fn.values()):8d}  [{internal[m]}]")
