// Layout engine plug-in for 06-rendering/host/dom/layout.js (env.layoutEngine): style resolution and box building stay in JavaScript; the box tree is packed
// into typed arrays, laid out by C (spike:layout, layout.c), and the geometry, text fragments, inline line rectangles and anonymous flex boxes are copied back
// onto the Box objects, so painting, getBoundingClientRect() and friends work unchanged.
import * as nl from 'spike:layout';
import { Box, anonStyle } from '../../06-rendering/host/dom/layout.js';
import { packTree } from './layout_pack.js';
import { fontsById } from './native_fonts.js';

const BO = 14, FO = 18, RO = 8;
const decode = (u16, off, len) => { if (len === 0) { return ''; } if (len <= 4096) { return String.fromCharCode.apply(null, u16.subarray(off, off + len)); } let s = ''; for (let i = 0; i < len; i += 4096) { s += String.fromCharCode.apply(null, u16.subarray(off + i, off + Math.min(len, i + 4096))); } return s; };
export const timing = { pack: 0, native: 0, apply: 0, runs: 0, perRun: [] };

export const engine = {
	run(lay, rootBox, vw, vh) {
		const t0 = performance.now(); const pk = packTree(lay, rootBox); const t1 = performance.now();
		const r = nl.layout(pk.boxes, pk.n, pk.calc, pk.text, vw, vh); const t2 = performance.now();
		const list = pk.list; const bo = r.boxes;
		// anonymous boxes created for text directly inside flex containers (C appended them after the packed boxes)
		const an = r.anons;
		for (let k = 0; k < an.length; k += 4) {
			const idx = an[k], parent = list[an[k + 1]], text = list[an[k + 2]]; const a = new Box(null, parent.cs, 'block'); a.v = anonStyle(parent.v); a.display = 'block'; a.anon = true; a.parent = parent; a.children = [text]; text.parent = a;
			const at = parent.children.indexOf(text); if (at >= 0) { parent.children[at] = a; } list[idx] = a;
		}
		for (let i = 0; i < r.total; i++) {
			const b = list[i]; if (b.kind === 'text') { continue; } const o = i * BO;
			b.ax = bo[o]; b.ay = bo[o + 1]; b.w = bo[o + 2]; b.h = bo[o + 3]; b.bl = bo[o + 4]; b.bt = bo[o + 5]; b.br = bo[o + 6]; b.bb = bo[o + 7]; b.hx = bo[o + 8]; b.vy = bo[o + 9]; b.scrollW = bo[o + 10]; b.scrollH = bo[o + 11]; b.relDx = bo[o + 12]; b.relDy = bo[o + 13];
		}
		const fr = r.frags, ft = r.fragText;
		for (let k = 0; k < fr.length; k += FO) {
			const owner = list[fr[k]], tb = list[fr[k + 1]];
			const f = { t: 'text', box: tb, node: tb.el, v: tb.parent.v, text: decode(ft, fr[k + 16], fr[k + 17]), x: fr[k + 2], y: fr[k + 3], w: fr[k + 4], asc: fr[k + 5], desc: fr[k + 6], baseline: fr[k + 7], src: fr[k + 8], srcEnd: fr[k + 9], font: fontsById[fr[k + 12]], size: fr[k + 11], ls: fr[k + 10], trailingSpaceW: 0, line: null, ax: fr[k + 13], ay: fr[k + 14], abaseline: fr[k + 15] };
			(owner.frags ??= []).push(f);
			if (f.node) { let l = lay.fragsByText.get(f.node); if (!l) { l = []; lay.fragsByText.set(f.node, l); } l.push(f); }
		}
		const rc = r.rects;
		for (let k = 0; k < rc.length; k += RO) {
			const b = list[rc[k]]; if (!b.__rects) { b.__rects = { box: b, rects: [], m: null }; }
			b.__rects.rects.push({ x: rc[k + 1], y: rc[k + 2], w: rc[k + 3], h: rc[k + 4], ax: rc[k + 7] ? rc[k + 5] : undefined, ay: rc[k + 7] ? rc[k + 6] : undefined });
		}
		const t3 = performance.now(); timing.pack += t1 - t0; timing.native += t2 - t1; timing.apply += t3 - t2; timing.runs++; timing.perRun.push([+(t1 - t0).toFixed(1), +(t2 - t1).toFixed(2), +(t3 - t2).toFixed(1), pk.n]);
	},
};
