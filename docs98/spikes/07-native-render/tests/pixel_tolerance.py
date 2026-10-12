#!/usr/bin/env python3
"""Compare two PPM framebuffers (reference vs candidate): max per-channel difference, mean absolute error, and the share of channel values off by more than 1, 2, 8 levels.
Usage: pixel_tolerance.py ref.ppm cand.ppm [--max-mean M] [--max-diff D]   (exit 1 when a limit is exceeded)"""
import sys
def read(p):
    d = open(p, 'rb').read(); i = 0; toks = []
    while len(toks) < 4:
        while d[i:i+1].isspace(): i += 1
        j = i
        while not d[j:j+1].isspace(): j += 1
        toks.append(d[i:j]); i = j
    return int(toks[1]), int(toks[2]), d[i+1:]
w, h, a = read(sys.argv[1]); w2, h2, b = read(sys.argv[2]); assert (w, h) == (w2, h2)
args = sys.argv[3:]; opt = lambda n, dflt: float(args[args.index(n) + 1]) if n in args else dflt
n = len(a); hist = [0] * 256; tot = 0
for x, y in zip(a, b):
    d = abs(x - y); hist[d] += 1; tot += d
mx = max(i for i in range(256) if hist[i]); over = lambda k: sum(hist[k+1:]) * 100.0 / n
print(f"{w}x{h}: max diff {mx}, mean abs diff {tot / n:.4f}, values off by >1: {over(1):.3f}%, >2: {over(2):.3f}%, >8: {over(8):.3f}%")
sys.exit(0 if mx <= opt('--max-diff', 255) and tot / n <= opt('--max-mean', 255) else 1)
