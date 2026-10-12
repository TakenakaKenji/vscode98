#!/usr/bin/env python3
"""Compare our DOM/layout dump with the Chromium ground truth, element by element (matched by tree path).
usage: compare.py truth.json ours.json [--verbose N]"""
import json, sys, collections
truth = json.load(open(sys.argv[1])); ours = json.load(open(sys.argv[2]))
verbose = int(sys.argv[sys.argv.index('--verbose') + 1]) if '--verbose' in sys.argv else 15
T = {e['path']: e for e in truth['elements']}; O = {e['path']: e for e in ours['elements']}
print(f"elements: chromium {len(T)}, ours {len(O)}; paths only in chromium {len(set(T)-set(O))}, only in ours {len(set(O)-set(T))}")
for p in sorted(set(T) - set(O))[:5]: print('  missing in ours:', p, T[p]['cls'])
for p in sorted(set(O) - set(T))[:5]: print('  extra in ours:', p, O[p]['cls'])
cls_mismatch = [p for p in T if p in O and T[p]['cls'].split() != O[p]['cls'].split()]
print('class attribute mismatches:', len(cls_mismatch)); [print('  ', p, repr(T[p]['cls']), '|', repr(O[p]['cls'])) for p in cls_mismatch[:5]]
def norm_style(s): return ';'.join(sorted(x.strip().replace(' ', '').replace("'", '"') for x in s.split(';') if x.strip()))
sty = [p for p in T if p in O and norm_style(T[p]['inlineStyle']) != norm_style(O[p]['inlineStyle'])]
print('inline style attribute mismatches:', len(sty)); 
def first_diff(a, b):
    a, b = norm_style(a), norm_style(b)
    for i in range(min(len(a), len(b))):
        if a[i] != b[i]: return i, a[max(0, i - 40):i + 60], b[max(0, i - 40):i + 60]
    return len(a), a[-60:], b[-60:]
for p in sty[:verbose // 2]:
    i, a, b = first_diff(T[p]['inlineStyle'], O[p]['inlineStyle']); print('  ', p.split('/')[-1], T[p]['cls'][:30], '\n     chromium ...', a, '\n     ours     ...', b)
tol = [0.5, 1, 2]
common = [p for p in T if p in O]
nan = [p for p in common if any(O[p][k] is None for k in 'xywh')]
print('elements with NaN geometry in ours:', len(nan), nan[:3])
common = [p for p in common if p not in nan]
vis = [p for p in common if T[p]['w'] > 0 or T[p]['h'] > 0]
def err(p):
    t, o = T[p], O[p]
    return max(abs((t[k] or 0) - (o[k] or 0)) for k in 'xywh')
for tl in tol: print(f'boxes (non-empty, {len(vis)}) within {tl}px on x,y,w,h: {sum(1 for p in vis if err(p) <= tl)}')
bad = sorted([p for p in vis if err(p) > 1], key=err, reverse=True)
for p in bad[:verbose]:
    t, o = T[p], O[p]; print(f"  err {err(p):7.1f}  {p.split('/')[-1]:14s} .{t['cls'][:40]:40s} chromium ({t['x']:.1f},{t['y']:.1f},{t['w']:.1f},{t['h']:.1f})  ours ({o['x']:.1f},{o['y']:.1f},{o['w']:.1f},{o['h']:.1f})")
for k in ('offsetW', 'offsetH'): print(k, 'matches:', sum(1 for p in common if 'offsetW' in T[p] and abs(T[p][k] - O[p][k]) <= 1), '/', len(common))
print('scrollW/H matches:', sum(1 for p in common if abs(T[p]['scrollW'] - O[p]['scrollW']) <= 1 and abs(T[p]['scrollH'] - O[p]['scrollH']) <= 1), '/', len(common))
print('text content matches:', sum(1 for p in common if T[p].get('text') == O[p].get('text')), '/', len(common))
