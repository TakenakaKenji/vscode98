import os, re, collections, sys
root=sys.argv[1]
imp=re.compile(r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'electron'|import\s+\*\s+as\s+(\w+)\s+from\s+'electron'|import\('electron'\)", re.S)
names=collections.defaultdict(set)
for dp,dn,fn in os.walk(root):
    dn[:]=[d for d in dn if d not in('node_modules','.git')]
    for f in fn:
        if not f.endswith('.ts'): continue
        p=os.path.join(dp,f); t=open(p,encoding='utf-8',errors='ignore').read()
        for m in imp.finditer(t):
            if m.group(1):
                for n in m.group(1).split(','):
                    n=n.strip().split(' as ')[0].replace('type ','').strip()
                    if n: names[n].add(os.path.relpath(p,root))
            else: names['<namespace/dynamic>'].add(os.path.relpath(p,root))
for k,v in sorted(names.items(), key=lambda kv:-len(kv[1])): print(f"{k}\t{len(v)}")
