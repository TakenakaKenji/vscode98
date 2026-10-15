// Decodes the images made by tests/make_images.py (PNG in every colour type, interlaced PNG, GIF, BMP, JPEG baseline/progressive/grey) and compares them with Pillow's decoding (exact for lossless formats, mean error for JPEG).
import * as std from 'qjs:std';
import { decodeImage } from '../dom/images.js';
const dir = '/tmp/claude-0/imgt'; const exp = JSON.parse(std.loadFile(dir + '/expected.json'));
const readBytes = (f) => { const h = std.open(f, 'rb'); h.seek(0, std.SEEK_END); const n = h.tell(); h.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); h.read(ab, 0, n); h.close(); return new Uint8Array(ab); };
for (const [f, [w, h, data]] of Object.entries(exp)) {
	try {
		const t0 = performance.now(); const r = decodeImage(readBytes(dir + '/' + f)); const ms = performance.now() - t0; let diff = 0, max = 0, bad = 0; for (let i = 0; i < data.length; i++) { const d = Math.abs(r.data[i] - data[i]); diff += d; if (d > max) { max = d; } if (d > 0) { bad++; } }
		console.log(f.padEnd(14) + (r.w === w && r.h === h ? 'size ok ' : 'SIZE ' + r.w + 'x' + r.h + ' ') + 'meanErr=' + (diff / data.length).toFixed(3) + ' maxErr=' + max + ' differing=' + bad + ' ' + ms.toFixed(1) + 'ms');
	} catch (e) { console.log(f.padEnd(14) + 'FAILED ' + e + ' ' + (e.stack || '').split('\n')[1]); }
}
