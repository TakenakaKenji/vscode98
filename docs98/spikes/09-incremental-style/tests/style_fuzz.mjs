// Randomised soundness test for incremental style invalidation: random documents and random stylesheets (descendant/child/sibling combinators, :not, :is, :has, structural
// and state pseudo-classes, attribute selectors, custom properties, inheritance, ::before) are mutated at random; after every layout pass the incrementally maintained styles must
// equal a from-scratch restyle (doc.__verifyStyles -> doc.__styleMismatches).
// Usage: node style_fuzz.mjs [seeds=200] [steps=25] [firstSeed=1]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const seeds = Number(process.argv[2] ?? 200), steps = Number(process.argv[3] ?? 25), first = Number(process.argv[4] ?? 1);
const env = installEnvironment({ width: 600, height: 400, opentype }); const doc = env.document;
const CLS = ['a', 'b', 'c', 'd', 'e', 'f']; const TAGS = ['div', 'span', 'ul', 'li', 'p', 'section'];
const SEL = [() => `.${c()}`, () => `.${c()} .${c()}`, () => `.${c()} > .${c()}`, () => `.${c()} + .${c()}`, () => `.${c()} ~ .${c()}`, () => `.${c()}:not(.${c()})`, () => `li:first-child`, () => `li:last-child`, () => `li:nth-child(2n+1)`, () => `li:nth-last-child(2)`, () => `p:only-child`,
	() => `.${c()}:has(.${c()})`, () => `.${c()}:has(> .${c()})`, () => `.${c()}:has(+ .${c()})`, () => `[data-x]`, () => `[data-x="1"] .${c()}`, () => `.${c()}[data-x="2"]`, () => `.${c()}:focus`, () => `.${c()}:focus-within .${c()}`, () => `.${c()}:focus-within`, () => `.${c()}:empty`, () => `.${c()}:is(.${c()}, .${c()}) > span`, () => `div .${c()} li`, () => `.${c()} .${c()} .${c()}`, () => `ul > li + li`, () => `.${c()}::before`, () => `.${c()}:not(:first-child)`, () => `.${c()}:first-child .${c()}`, () => `*`, () => `span`, () => `section > *`, () => `.${c()}:nth-child(odd)`, () => `:is(.${c()}, .${c()}):last-child`];
const DECL = [() => `color: ${['red', 'green', 'blue', '#123456', 'rgb(1,2,3)'][r(5)]}`, () => `font-size: ${[10, 12, 14, 16, 20][r(5)]}px`, () => `font-size: ${[0.8, 1, 1.2, 1.5][r(4)]}em`, () => `width: ${[10, 50, 100][r(3)]}px`, () => `margin: ${r(10)}px`, () => `padding-left: ${r(8)}px`, () => `display: ${['block', 'inline', 'flex', 'none', 'inline-block'][r(5)]}`, () => `--v: ${['1px', '2px', 'red', 'blue'][r(4)]}`, () => `color: var(--v, green)`, () => `width: var(--v, 5px)`, () => `font-weight: ${[400, 700][r(2)]}`, () => `line-height: ${[1, 1.5, 20][r(3)]}`, () => `content: "x"`, () => `visibility: ${['visible', 'hidden'][r(2)]}`, () => `text-align: ${['left', 'center'][r(2)]}`];
let seed = 1; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; const r = (n) => Math.floor(rnd() * n); const c = () => CLS[r(CLS.length)]; const pick = (a) => a[r(a.length)];
const rule = () => `${SEL[r(SEL.length)]()} { ${Array.from({ length: 1 + r(3) }, () => DECL[r(DECL.length)]()).join('; ')} }`;
const mkEl = (depth) => { const e = doc.createElement(pick(TAGS)); if (rnd() < 0.7) { e.className = Array.from({ length: 1 + r(3) }, c).join(' '); } if (rnd() < 0.15) { e.setAttribute('data-x', String(1 + r(2))); } if (rnd() < 0.1) { e.id = 'i' + r(4); } if (depth < 4) { const n = r(4); for (let i = 0; i < n; i++) { e.appendChild(mkEl(depth + 1)); } } if (rnd() < 0.3) { e.appendChild(doc.createTextNode(rnd() < 0.5 ? 'text' : '')); } return e; };
const all = () => [...doc.body.getElementsByTagName('*')];
const MUT = [
	() => { const e = pick(all()); if (e) { e.classList.add(c()); } }, () => { const e = pick(all()); if (e) { e.classList.remove(c()); } }, () => { const e = pick(all()); if (e) { e.classList.toggle(c()); } },
	() => { const e = pick(all()); if (e) { e.className = Array.from({ length: r(3) }, c).join(' '); } }, () => { const e = pick(all()); if (e) { e.setAttribute('data-x', String(1 + r(2))); } }, () => { const e = pick(all()); if (e) { e.removeAttribute('data-x'); } },
	() => { const e = pick(all()); if (e) { e.style.color = pick(['red', 'blue', '']); } }, () => { const e = pick(all()); if (e) { e.style.fontSize = pick(['10px', '1.2em', '']); } }, () => { const e = pick(all()); if (e) { e.id = rnd() < 0.5 ? 'i' + r(4) : ''; } },
	() => { const p = pick(all()); if (p && p.localName !== 'svg') { const k = p.__children.length; p.insertBefore(mkEl(2), p.__children[r(k + 1)] ?? null); } }, () => { const p = pick(all()); if (p && p.parentNode && p.parentNode !== doc.body) { p.parentNode.removeChild(p); } },
	() => { const a = pick(all()), b = pick(all()); if (a && b && a !== b && !a.contains(b) && a.parentNode) { b.insertBefore(a, b.__children[r(b.__children.length + 1)] ?? null); } }, () => { const e = pick(all()); if (e) { e.appendChild(doc.createTextNode('more')); } },
	() => { const e = pick(all()); if (e) { for (const k of [...e.__children]) { if (k.nodeType === 3) { e.removeChild(k); } } } }, () => { const e = pick(all()); if (e && e.localName !== 'x') { e.focus(); } }, () => { const e = doc.__activeElement; if (e) { e.blur(); } },
	() => { const s = doc.createElement('style'); s.textContent = rule() + '\n' + rule(); s.setAttribute('data-fuzz', '1'); (rnd() < 0.5 ? doc.head : doc.body).appendChild(s); }, () => { const s = doc.querySelectorAll('style[data-fuzz]'); if (s.length) { const e = s[r(s.length)]; e.parentNode.removeChild(e); } },
	() => { const s = doc.querySelectorAll('style[data-fuzz]'); if (s.length) { s[r(s.length)].textContent = rule(); } }, () => { const e = pick(all()); if (e && e.__children.length) { const k = e.__children.find(x => x.nodeType === 3); if (k) { k.data = rnd() < 0.5 ? '' : 'changed'; } } },
	() => { const e = pick(all()); if (e) { const n = e.cloneNode(true); const p = pick(all()); if (p) { p.appendChild(n); } } },
];
let passes = 0, incremental = 0, fullPasses = 0, recomputed = 0, totalEls = 0, bad = 0; const reasons = new Map();
for (let s = first; s < first + seeds; s++) {
	seed = s * 2654435761 % 4294967296 || 1; doc.head.__children.length = 0; doc.body.__children.length = 0; doc.__styleReady = false; doc.__ruleIndex = null; doc.__styleMismatches = []; doc.__verifyStyles = true; doc.__layout = null;
	const st = doc.createElement('style'); st.textContent = Array.from({ length: 25 + r(30) }, rule).join('\n'); doc.head.appendChild(st);
	const root = doc.createElement('div'); root.className = 'a'; for (let i = 0; i < 4 + r(3); i++) { root.appendChild(mkEl(1)); } doc.body.appendChild(root); doc.__ensureLayout();
	for (let step = 0; step < steps; step++) {
		const n = 1 + r(4); const applied = []; for (let i = 0; i < n; i++) { const m = r(MUT.length); applied.push(m); try { MUT[m](); } catch (e) { /* illegal DOM operation in this state */ } }
		const logCopy = (doc.__dirtyLog || []).map(([k, w, n, a, x]) => `${w}:${n.nodeType === 1 ? n.localName + '.' + n.classes().join('.') : n.nodeName}${typeof a === 'string' ? '/' + a : (a && a.nodeType === 1 ? '/+' + a.localName + '.' + a.classes().join('.') : '')}${x !== undefined ? '@' + String(x).slice(0, 12) : ''}`);
		doc.__ensureLayout(); const info = doc.__styleInfo; passes++; if (info.mode === 'full') { fullPasses++; reasons.set(info.reason, (reasons.get(info.reason) || 0) + 1); } else { incremental++; recomputed += info.recomputed; totalEls += info.total; }
		if (doc.__styleMismatches.length) { bad++; console.log(`MISMATCH seed ${s} step ${step} (mutations ${applied.join(',')}, mode ${info.mode}):`); for (const m of doc.__styleMismatches.slice(0, 4)) { console.log('   ' + m); } console.log('   log: ' + logCopy.slice(0, 12).join(' | ')); console.log('   marks: ' + JSON.stringify(info.marked)); doc.__styleMismatches = []; if (bad >= 10) { break; } }
	}
	if (bad >= 10) { break; }
}
console.log(`${passes} passes: ${incremental} incremental (restyled ${recomputed} of ${totalEls} elements = ${(100 * recomputed / Math.max(1, totalEls)).toFixed(1)} %), ${fullPasses} full ${JSON.stringify([...reasons])}; mismatching passes: ${bad}`);
process.exit(bad ? 1 : 0);
