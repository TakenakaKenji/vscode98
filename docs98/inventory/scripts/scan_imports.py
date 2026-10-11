import os, re, sys, collections, json
root = sys.argv[1]
builtins = set("assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split())
pat = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]""")
res = collections.defaultdict(lambda: collections.defaultdict(set))   # module -> layer -> files
elec = collections.defaultdict(lambda: collections.defaultdict(set))
other = collections.defaultdict(set)
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in ('node_modules','test','.git')]
    for f in fn:
        if not f.endswith(('.ts','.js','.mjs','.cjs')) or f.endswith('.d.ts'): continue
        p = os.path.join(dp, f)
        rel = os.path.relpath(p, root)
        parts = rel.split(os.sep)
        layer = next((x for x in parts if x in ('common','browser','node','electron-main','electron-browser','electron-sandbox','electron-utility','worker')), 'other')
        try: txt = open(p, encoding='utf-8', errors='ignore').read()
        except: continue
        for m in pat.finditer(txt):
            mod = m.group(1)
            base = mod[5:] if mod.startswith('node:') else mod
            top = base.split('/')[0]
            if top in builtins: res[base][layer].add(rel)
            elif top == 'electron': elec[mod][layer].add(rel)
            elif not mod.startswith('.') and not mod.startswith('vs/') and not mod.startswith('vscode'):
                other[mod].add(rel)
def dump(d):
    out = []
    for k, v in sorted(d.items(), key=lambda kv: -sum(len(s) for s in kv[1].values())):
        out.append((k, sum(len(s) for s in v.values()), {l: len(s) for l, s in sorted(v.items())}))
    return out
json.dump({'node': dump(res), 'electron': dump(elec), 'other': sorted(((k, len(v)) for k, v in other.items()), key=lambda x: -x[1])}, open(sys.argv[2], 'w'), indent=1)
