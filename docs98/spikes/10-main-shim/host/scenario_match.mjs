// Desktop scenario: micro-benchmark of selector matching on the settled workbench (real DOM, real rule index). For every element it runs the matcher used by the style pass
// (matchedDeclarationsAll, with the per-pass ancestor memo) and the plain one (matchedDeclarations, the oracle), compares the results and reports the time per element.
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
import { matchedDeclarations, matchedDeclarationsAll } from '../../06-rendering/host/dom/css.js';
import { setMatchMemo } from '../../06-rendering/host/dom/selectors.js';
export async function run(ctx) {
	const { doc, log } = ctx; await runScenario(ctx, { seconds: 60, stableRounds: 40 });
	const index = doc.__ruleIndex; const els = [...doc.getElementsByTagName('*')]; log(`match: ${els.length} elements, ${index.count} rules`);
	const rounds = Number(ctx.opt('rounds', 3)); let bad = 0, cands = 0;
	for (const el of els) { if (!el.__anc) { el.__anc = undefined; } }
	let t = performance.now(); let fast = null;
	for (let r = 0; r < rounds; r++) { setMatchMemo(1000 + r); fast = els.map(el => matchedDeclarationsAll(el, index)); setMatchMemo(0); }
	{ const k = {}; for (const e of index.universal) { const c = e.complex.parts[e.complex.parts.length - 1].compound; const key = (c.attrs.map(a => '[' + a.name + ']').join('') + c.pseudos.map(p => ':' + p.name).join('')) || '*'; k[key] = (k[key] || 0) + 1; } log('match: universal ' + index.universal.length + ' ' + JSON.stringify(Object.entries(k).sort((a, b) => b[1] - a[1]).slice(0, 30))); }
	const tFast = (performance.now() - t) / rounds;
	t = performance.now(); let slow = null; for (let r = 0; r < rounds; r++) { slow = els.map(el => [matchedDeclarations(el, index, null, null), matchedDeclarations(el, index, null, 'before'), matchedDeclarations(el, index, null, 'after')]); } const tSlow = (performance.now() - t) / rounds;
	for (let i = 0; i < els.length; i++) { for (let k = 0; k < 3; k++) { const a = fast[i][k], b = slow[i][k]; cands += a.length; if (a.length !== b.length || a.some((e, j) => e !== b[j])) { bad++; } } }
	{ const tot = { id: 0, cls: 0, tag: 0, uni: 0, needCls: 0, needTag: 0, needUni: 0 }; const top = new Map(); for (const el of els) { const id = el.getAttribute('id'); if (id) { tot.id += (index.byId.get(id) || []).length; } for (const c of el.classes()) { const l = index.byClass.get(c) || []; tot.cls += l.length; tot.needCls += l.filter(e => e.need.length).length; top.set('.' + c, l.length); } const l = index.byTag.get(el.localName) || []; tot.tag += l.length; tot.needTag += l.filter(e => e.need.length).length; top.set(el.localName, l.length); }
		tot.uni = index.universal.length * els.length; log('match: candidates over all elements ' + JSON.stringify(tot) + ' largest buckets ' + JSON.stringify([...top].sort((a, b) => b[1] - a[1]).slice(0, 12))); }
	log(`match: pass matcher ${tFast.toFixed(0)} ms for all elements (${(tFast / els.length).toFixed(2)} ms each), plain matcher x3 pseudo walks ${tSlow.toFixed(0)} ms; ${cands} matched rules, ${bad} mismatches`);
}
