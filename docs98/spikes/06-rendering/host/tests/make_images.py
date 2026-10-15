# Makes the test images of images_test.mjs in /tmp/claude-0/imgt (needs Pillow): PNG in every colour type, interlaced PNG, GIF, BMP, JPEG baseline/progressive/grey, and expected.json (Pillow's decoding).
import os, json, zlib, struct
from PIL import Image, ImageDraw
os.makedirs('/tmp/claude-0/imgt', exist_ok=True); os.chdir('/tmp/claude-0/imgt')
def pattern(w, h):
    im = Image.new('RGBA', (w, h)); px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x * 255 // w, y * 255 // h, ((x + y) * 5) % 256, 255 if (x // 8 + y // 8) % 5 else 128)
    d = ImageDraw.Draw(im); d.ellipse((w // 4, h // 4, 3 * w // 4, 3 * h // 4), outline=(255, 0, 0, 255), width=3); d.text((4, 4), 'Hi', fill=(255, 255, 255, 255)); return im
im = pattern(70, 53); im.save('rgba.png'); im.convert('RGB').save('rgb.png'); im.convert('L').save('gray.png'); im.convert('LA').save('la.png'); im.convert('P', palette=Image.ADAPTIVE, colors=16).save('pal.png'); im.convert('1').save('bw.png')
im.convert('RGB').save('base.jpg', quality=85); im.convert('RGB').save('prog.jpg', quality=85, progressive=True); im.convert('RGB').save('base444.jpg', quality=90, subsampling=0); im.convert('L').save('gray.jpg'); im.convert('P').save('p.gif'); im.convert('RGB').save('x.bmp')
def png_adam7(img):
    w, h = img.size; px = img.convert('RGBA').load(); raw = b''
    for x0, y0, dx, dy in [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]:
        pw = (w - x0 + dx - 1) // dx; ph = (h - y0 + dy - 1) // dy
        if pw <= 0 or ph <= 0: continue
        for py in range(ph):
            raw += b'\x00'
            for q in range(pw): raw += bytes(px[x0 + q * dx, y0 + py * dy])
    def chunk(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 1)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open('adam7.png', 'wb').write(png_adam7(im))
exp = {}
for f in ['rgba.png', 'rgb.png', 'gray.png', 'la.png', 'pal.png', 'bw.png', 'adam7.png', 'p.gif', 'x.bmp', 'base.jpg', 'prog.jpg', 'base444.jpg', 'gray.jpg']:
    i = Image.open(f).convert('RGBA'); exp[f] = [i.size[0], i.size[1], list(i.tobytes())]
json.dump(exp, open('expected.json', 'w'))
