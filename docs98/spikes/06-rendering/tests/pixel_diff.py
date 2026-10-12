#!/usr/bin/env python3
"""Pixel comparison of two screenshots (PNG/PPM): mean absolute error, fraction of differing pixels, and a visual diff image.
usage: pixel_diff.py truth.png ours.(png|ppm) out_prefix"""
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')
assert a.size == b.size, (a.size, b.size)
d = ImageChops.difference(a, b); px = list(d.getdata()); n = len(px)
mae = sum(sum(p) for p in px) / (3 * n)
def frac(t): return sum(1 for p in px if max(p) > t) / n
nonwhite = sum(1 for p in a.getdata() if p != (255, 255, 255)); 
print(f"size {a.size}; mean abs error {mae:.3f}/255; pixels differing >16: {frac(16)*100:.2f}%  >64: {frac(64)*100:.2f}%  >128: {frac(128)*100:.2f}%; non-white pixels in truth {nonwhite} ({nonwhite/n*100:.1f}%)")
# side-by-side with diff
w, h = a.size; out = Image.new('RGB', (w * 3, h), 'white'); out.paste(a, (0, 0)); out.paste(b, (w, 0)); out.paste(ImageChops.invert(d), (2 * w, 0)); out.save(sys.argv[3] + '_side.png')
