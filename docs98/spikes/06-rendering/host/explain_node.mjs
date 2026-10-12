// node explain_node.mjs <captured.json> <path-suffix-or-class> [n]  : print our computed style + box for matching elements (debugging aid for the replay)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { installEnvironment } from './dom/env.js';
import { replayPage, applyScrolls } from './dom/replay_core.js';
import { matchedDeclarations } from './dom/css.js';
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
const [file, key, nstr] = process.argv.slice(2); const data = JSON.parse(fs.readFileSync(file, 'utf8'));
globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const env = installEnvironment({ width: data.w, height: data.h, opentype }); const doc = replayPage(env, data); applyScrolls(doc, data.elements); doc.__ensureLayout();
const truth = new Map(data.elements.map(r => [r.path, r])); let shown = 0; const max = Number(nstr || 1);
const walk = (el, path) => {
	if (shown < max && (path.endsWith(key) || ((el.getAttribute('class') || '').split(/\s+/).includes(key) || el.localName === key))) {
		shown++; const b = doc.__layout.boxOf.get(el); const v = el.__cs.values; const t = truth.get(path);
		const keys = ['display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'align-items', 'justify-content', 'margin-top', 'margin-left', 'padding-left', 'padding-top', 'border-left-width', 'box-sizing', 'overflow-x', 'line-height', 'font-size', 'font-family', 'white-space', 'top', 'left', 'right', 'bottom', 'float', 'vertical-align'];
		console.log('PATH', path); console.log('chromium', JSON.stringify(t && { x: t.x, y: t.y, w: t.w, h: t.h, display: t.display, position: t.position, flex: t.flex, cwidth: t.cwidth, cmaxw: t.cmaxw, cminw: t.cminw, cdir: t.cdir, cmargin: t.cmargin, fsize: t.fsize, fweight: t.fweight }));
		console.log('ours    ', JSON.stringify(b && { x: b.ax, y: b.ay, w: b.w, h: b.h, kind: b.kind }));
		console.log('style   ', JSON.stringify(Object.fromEntries(keys.map(k => [k, v[k]]))));
		const idx = doc.__ruleIndex; for (const e of matchedDeclarations(el, idx, null, null)) { const names = ['display', 'width', 'height', 'flex', 'flex-grow', 'flex-basis', 'padding-left', 'padding-right', 'min-width', 'position', 'font-size', 'font-weight', 'letter-spacing'].filter(n => e.decls.some(d => d.name === n)); if (names.length) { console.log('  rule', e.complex.parts.map(p => (p.comb !== ' ' ? p.comb : '') + (p.compound.tag || '') + p.compound.classes.map(c => '.' + c).join('')).join(' ').slice(0, 110), '=>', e.decls.filter(d => names.includes(d.name)).map(d => d.name + ':' + d.value).join('; ').slice(0, 120)); } }
		console.log('before', JSON.stringify(el.__before && el.__before.values.content), 'font-family', JSON.stringify(v['font-family']), 'pseudo-box', JSON.stringify((b.children[0] || {}).text), b.children[0] && b.children[0].children && JSON.stringify(b.children[0].children.map(x => x.text)));
		console.log('children', el.children.map(c => c.localName + '.' + (c.className || '').slice(0, 20)).join(' | ').slice(0, 200));
	}
	let i = 0; for (const c of el.children) { walk(c, path + '/' + c.localName + '[' + (i++) + ']'); }
};
walk(doc.documentElement, 'html');
const { resolveFont } = await import('./dom/fonts.js'); const f = resolveFont('codicon', 400, 'normal'); console.log('codicon resolves to', f && JSON.stringify(f.names.fontFamily || f.names), 'glyph', f.charToGlyph('\uea6c').index);
process.exit(0);
